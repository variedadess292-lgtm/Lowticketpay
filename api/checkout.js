
import { db } from "./_lib/firebaseAdmin.js";

const EPAY_URL = "https://checkout.epay.co.mz/api/v1/payments";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const secretKey = process.env.EPAY_SECRET_KEY;
    const appUrl = process.env.APP_URL;

    if (!secretKey || !appUrl) {
      return res.status(500).json({
        error: "Configuração de pagamentos incompleta."
      });
    }

    const {
      productId,
      customerName,
      customerEmail
    } = req.body || {};

    if (!productId || typeof productId !== "string") {
      return res.status(400).json({
        error: "Produto inválido."
      });
    }

    if (!customerName || typeof customerName !== "string") {
      return res.status(400).json({
        error: "Indica o nome do comprador."
      });
    }

    // Consultar o produto verdadeiro no Firestore
    const productRef = db.collection("produtos").doc(productId);
    const productSnap = await productRef.get();

    if (!productSnap.exists) {
      return res.status(404).json({
        error: "Produto não encontrado."
      });
    }

    const product = productSnap.data();

    if (
      product.ativo === false ||
      product.status === "inativo" ||
      !product.ownerId
    ) {
      return res.status(400).json({
        error: "Este produto não está disponível."
      });
    }

    const amount = Number(product.preco);

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        error: "Preço do produto inválido."
      });
    }

    // Criar registo pendente
    const orderRef = db.collection("transacoes").doc();

    await orderRef.set({
      orderId: orderRef.id,
      productId,
      productName: product.nome || "Produto digital",
      sellerId: product.ownerId,
      customerName: customerName.trim(),
      customerEmail: customerEmail || null,
      amount,
      currency: "MZN",
      status: "pending",
      paymentProvider: "epay",
      createdAt: new Date()
    });

    // Criar pagamento na ePay
    const response = await fetch(EPAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        amount,
        currency: "MZN",
        description: product.nome || "Compra KLIKPay",
        external_reference: orderRef.id,
        customer_name: customerName.trim(),
        customer_email: customerEmail || undefined,
        return_url: `${appUrl}/pagamento.html?pedido=${orderRef.id}`,
        cancel_url: `${appUrl}/pagamento.html?pedido=${orderRef.id}`,
        callback_url: `${appUrl}/api/epay-webhook`
      })
    });

    const payment = await response.json();

    if (!response.ok || !payment.id) {
      await orderRef.update({
        status: "failed",
        paymentError: payment.message || "Erro ao criar pagamento."
      });

      return res.status(502).json({
        error: "Não foi possível iniciar o pagamento."
      });
    }

    await orderRef.update({
      epayPaymentId: payment.id,
      paymentUrl: payment.payment_url,
      paymentStatus: payment.status
    });

    return res.status(201).json({
      success: true,
      orderId: orderRef.id,
      paymentId: payment.id,
      paymentUrl: payment.payment_url,
      amount,
      currency: "MZN",
      status: "pending"
    });

  } catch (error) {
    console.error("Checkout error:", error);

    return res.status(error.status || 500).json({
      error: "Erro interno ao iniciar checkout."
    });
  }
}
