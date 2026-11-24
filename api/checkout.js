
import { db } from "./_lib/firebaseAdmin.js";
import crypto from "crypto";

const EPAY_URL = "https://checkout.epay.co.mz/api/v1/payments";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const { productId, customerName, customerEmail } = req.body || {};

    if (
      typeof productId !== "string" ||
      typeof customerName !== "string" ||
      customerName.trim().length < 2
    ) {
      return res.status(400).json({
        error: "Preencha correctamente os seus dados."
      });
    }

    if (
      customerEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
    ) {
      return res.status(400).json({
        error: "E-mail inválido."
      });
    }

    const appUrl = process.env.APP_URL;
    const secretKey = process.env.EPAY_SECRET_KEY;

    if (!appUrl || !secretKey) {
      throw new Error("Configurações de pagamento incompletas.");
    }

    // Procurar produto no Firestore.
    const productRef = db.collection("produtos").doc(productId);
    const productSnap = await productRef.get();

    if (!productSnap.exists) {
      return res.status(404).json({
        error: "Produto não encontrado."
      });
    }

    const product = productSnap.data();

    if (
      product.ativo !== true ||
      product.status === "Desactivado" ||
      product.status === "Desativado"
    ) {
      return res.status(400).json({
        error: "Este produto não está disponível."
      });
    }

    const amount = Number(product.preco);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Preço do produto inválido."
      });
    }

    if (amount > 250000) {
      return res.status(400).json({
        error: "O valor máximo permitido é 250.000 MT."
      });
    }

    if (!product.ownerId) {
      return res.status(400).json({
        error: "O produto não tem vendedor associado."
      });
    }

    // Criar referência única para a encomenda.
    const orderId = crypto.randomUUID();

    const orderRef = db.collection("transacoes").doc(orderId);

    await orderRef.set({
      orderId,
      productId,
      productName: product.nome || "Produto KLIKPay",
      sellerId: product.ownerId,
      customerName: customerName.trim(),
      customerEmail: customerEmail?.trim().toLowerCase() || null,
      amount,
      currency: "MZN",
      status: "pending",
      paymentStatus: "pending",
      paymentProvider: "epay",
      createdAt: new Date()
    });

    // Criar pagamento na ePay.
    const response = await fetch(EPAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        amount: amount.toFixed(2),
        currency: "MZN",
        description: product.nome || "Compra na KLIKPay",
        external_reference: orderId,
        customer_name: customerName.trim(),
        customer_email: customerEmail?.trim().toLowerCase() || undefined,
        return_url: `${appUrl}/pagamento.html?pedido=${encodeURIComponent(orderId)}`,
        cancel_url: `${appUrl}/pagamento.html?pedido=${encodeURIComponent(orderId)}`,
        callback_url: `${appUrl}/api/epay-webhook`
      })
    });

    const result = await response.json();

    if (!response.ok || !result.id) {
      await orderRef.update({
        status: "failed",
        paymentStatus: "failed",
        paymentError: result.message || "Falha ao criar pagamento."
      });

      return res.status(response.status || 502).json({
        error: result.message || "Não foi possível criar o pagamento."
      });
    }

    await orderRef.update({
      epayPaymentId: result.id,
      paymentUrl: result.payment_url || null,
      paymentStatus: result.status || "pending"
    });

    return res.status(200).json({
      success: true,
      orderId,
      paymentId: result.id,
      amount,
      currency: "MZN",
      productName: product.nome || "Produto KLIKPay"
    });

  } catch (error) {
    console.error("Checkout error:", error.message);

    return res.status(500).json({
      error: "Não foi possível iniciar a encomenda."
    });
  }
}
