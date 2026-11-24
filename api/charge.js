
import { db } from "./_lib/firebaseAdmin.js";

const EPAY_URL = "https://checkout.epay.co.mz/api/v1/payments";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const { orderId, method, phone } = req.body || {};

    if (
      typeof orderId !== "string" ||
      !["mpesa", "emola", "izi"].includes(method) ||
      typeof phone !== "string"
    ) {
      return res.status(400).json({
        error: "Dados de pagamento inválidos."
      });
    }

    const normalizedPhone = phone.replace(/[\s-]/g, "");

    if (!/^(\+258)?8[2-7]\d{7}$/.test(normalizedPhone)) {
      return res.status(400).json({
        error: "Número de telefone inválido."
      });
    }

    if (
      method === "mpesa" &&
      !/^(\+258)?8[45]\d{7}$/.test(normalizedPhone)
    ) {
      return res.status(400).json({
        error: "M-Pesa requer um número iniciado por 84 ou 85."
      });
    }

    if (
      method === "emola" &&
      !/^(\+258)?8[67]\d{7}$/.test(normalizedPhone)
    ) {
      return res.status(400).json({
        error: "e-Mola requer um número iniciado por 86 ou 87."
      });
    }

    const orderRef = db.collection("transacoes").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        error: "Encomenda não encontrada."
      });
    }

    const order = orderSnap.data();

    if (
      !order.epayPaymentId ||
      !["pending", "failed"].includes(order.status)
    ) {
      return res.status(409).json({
        error: "Esta encomenda não está disponível para pagamento."
      });
    }

    const amount = Number(order.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Valor da encomenda inválido."
      });
    }

    if (method !== "izi" && amount > 25000) {
      return res.status(400).json({
        error: "Para pagamentos acima de 25.000 MT, utilize IZI."
      });
    }

    const secretKey = process.env.EPAY_SECRET_KEY;

    if (!secretKey) {
      throw new Error("EPAY_SECRET_KEY não configurada.");
    }

    const response = await fetch(
      `${EPAY_URL}/${encodeURIComponent(order.epayPaymentId)}/charge`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          method,
          phone: normalizedPhone,
          customer_name: order.customerName,
          customer_email: order.customerEmail || undefined
        })
      }
    );

    let result = {};

    try {
      result = await response.json();
    } catch {
      result = {};
    }

    const allowedFields = [
      "id",
      "status",
      "state",
      "payment_type",
      "phone",
      "initiating",
      "remaining_seconds",
      "timeout",
      "polling_interval",
      "rejection_message",
      "message",
      "errors"
    ];

    const safeResult = Object.fromEntries(
      allowedFields
        .filter(key => key in result)
        .map(key => [key, result[key]])
    );

    if (response.ok) {
      await orderRef.update({
        status: "pending",
        paymentStatus: result.status || "pending",
        paymentMethod: method,
        customerPhone: normalizedPhone,
        chargeState: result.state || "initiating",
        chargeRequestedAt: new Date(),
        paymentFailureMessage: null
      });
    }

    return res.status(response.status).json(safeResult);

  } catch (error) {
    console.error("Charge error:", error.message);

    return res.status(500).json({
      error: "Não foi possível iniciar a cobrança."
    });
  }
}
