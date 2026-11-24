
import { db } from "./_lib/firebaseAdmin.js";

const EPAY_URL = "https://checkout.epay.co.mz/api/v1/payments";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  try {
    const { orderId } = req.body || {};

    if (typeof orderId !== "string" || !orderId.trim()) {
      return res.status(400).json({ error: "Encomenda inválida." });
    }

    const secretKey = process.env.EPAY_SECRET_KEY;

    if (!secretKey) {
      throw new Error("EPAY_SECRET_KEY não configurada.");
    }

    const orderRef = db.collection("transacoes").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Encomenda não encontrada." });
    }

    const order = orderSnap.data();

    if (!order.epayPaymentId) {
      return res.status(409).json({ error: "Pagamento não iniciado." });
    }

    if (order.status === "paid") {
      return res.status(200).json({
        status: "paid",
        message: "Pagamento confirmado."
      });
    }

    const headers = {
      Authorization: `Bearer ${secretKey}`,
      Accept: "application/json"
    };

    // Consulta o estado do pedido de PIN junto do banco.
    const statusResponse = await fetch(
      `${EPAY_URL}/${encodeURIComponent(order.epayPaymentId)}/status`,
      { headers }
    );

    const statusData = await statusResponse.json();

    if (!statusResponse.ok) {
      return res.status(statusResponse.status).json({
        error: statusData.message || "Não foi possível consultar o pagamento."
      });
    }

    // Só confirma os dados completos quando a ePay indicar pagamento.
    if (statusData.status === "paid") {
      const paymentResponse = await fetch(
        `${EPAY_URL}/${encodeURIComponent(order.epayPaymentId)}`,
        { headers }
      );

      const paymentData = await paymentResponse.json();

      if (!paymentResponse.ok) {
        return res.status(502).json({
          error: "Não foi possível validar os dados do pagamento."
        });
      }

      const expectedAmount = Math.round(Number(order.amount) * 100);
      const receivedAmount = Math.round(Number(paymentData.amount) * 100);

      if (
        paymentData.id !== order.epayPaymentId ||
        paymentData.external_reference !== orderId ||
        paymentData.currency !== "MZN" ||
        paymentData.status !== "paid" ||
        !Number.isFinite(expectedAmount) ||
        receivedAmount !== expectedAmount
      ) {
        console.error("Divergência na validação do pagamento:", orderId);

        return res.status(409).json({
          error: "Os dados do pagamento não correspondem à encomenda."
        });
      }

      // Atualiza a encomenda uma única vez.
      await db.runTransaction(async transaction => {
        const freshSnap = await transaction.get(orderRef);

        if (!freshSnap.exists) {
          throw new Error("Encomenda não encontrada.");
        }

        const freshOrder = freshSnap.data();

        if (freshOrder.status === "paid") return;

        if (
          freshOrder.epayPaymentId !== order.epayPaymentId ||
          freshOrder.status === "refunded" ||
          freshOrder.status === "cancelled"
        ) {
          throw new Error("Estado da encomenda incompatível.");
        }

        transaction.update(orderRef, {
          status: "paid",
          paymentStatus: "paid",
          paymentMethod: paymentData.payment_type || null,
          paidAt: new Date()
        });
      });

      return res.status(200).json({
        status: "paid",
        message: "Pagamento confirmado."
      });
    }

    // Regista o estado sem marcar a venda como paga.
    if (statusData.status === "failed") {
      await orderRef.update({
        paymentStatus: "failed",
        paymentFailureMessage: statusData.rejection_message || null
      });
    }

    return res.status(200).json({
      status: statusData.status,
      initiating: statusData.initiating || false,
      remaining_seconds: statusData.remaining_seconds ?? 0,
      polling_interval: statusData.polling_interval || 5,
      rejection_message: statusData.rejection_message || null,
      message: statusData.message || null
    });

  } catch (error) {
    console.error("Payment status error:", error.message);

    return res.status(500).json({
      error: "Não foi possível verificar o pagamento."
    });
  }
}
