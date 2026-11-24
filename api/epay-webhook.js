
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./_lib/firebaseAdmin.js";

export const config = {
  api: {
    bodyParser: false
  }
};

async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function safeCompare(expected, received) {
  if (!received || expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex")
  );
}

function verifySignature(rawBody, headers) {
  const apiSecret = process.env.EPAY_SECRET_KEY;
  const webhookSecret = process.env.EPAY_WEBHOOK_SECRET;

  // Assinatura dos webhooks gerais do painel ePay
  const signatureHeader = headers["x-epay-signature"];

  if (signatureHeader && webhookSecret) {
    const parts = Object.fromEntries(
      signatureHeader.split(",").map(part => {
        const index = part.indexOf("=");
        return [
          part.slice(0, index).trim(),
          part.slice(index + 1).trim()
        ];
      })
    );

    const timestamp = Number(parts.t);
    const received = parts.v1 || "";

    if (
      Number.isFinite(timestamp) &&
      Math.abs(Date.now() / 1000 - timestamp) <= 300
    ) {
      const expected = createHmac("sha256", webhookSecret)
        .update(`${timestamp}.${rawBody.toString("utf8")}`)
        .digest("hex");

      if (safeCompare(expected, received)) {
        return true;
      }
    }
  }

  // Assinatura dos callbacks individuais da API
  const callbackSignature = headers["x-educavelpay-signature"];

  if (callbackSignature && apiSecret) {
    const expected = createHmac("sha256", apiSecret)
      .update(rawBody)
      .digest("hex");

    if (safeCompare(expected, callbackSignature)) {
      return true;
    }
  }

  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const rawBody = await getRawBody(req);

    if (!rawBody.length || rawBody.length > 1024 * 1024) {
      return res.status(400).json({
        error: "Corpo inválido."
      });
    }

    if (!verifySignature(rawBody, req.headers)) {
      return res.status(401).json({
        error: "Assinatura inválida."
      });
    }

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({
        error: "JSON inválido."
      });
    }

    const eventType =
      req.headers["x-epay-event"] ||
      payload.event ||
      (payload.status === "paid" ? "payment.paid" : null) ||
      (payload.status === "failed" ? "payment.failed" : null);

    const data = payload.data || payload;

    const paymentId = data.id;
    const orderId = data.external_reference;

    if (!paymentId || !orderId) {
      return res.status(400).json({
        error: "Referência de pagamento inválida."
      });
    }

    const allowedEvents = [
      "payment.paid",
      "payment.failed",
      "refund.approved",
      "refund.rejected"
    ];

    if (!allowedEvents.includes(eventType)) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    const deliveryId =
      req.headers["x-epay-delivery"] ||
      payload.id ||
      paymentId;

    const deliveryRef = db
      .collection("epayWebhookEvents")
      .doc(String(deliveryId));

    const orderRef = db.collection("transacoes").doc(String(orderId));

    await db.runTransaction(async transaction => {
      const deliverySnap = await transaction.get(deliveryRef);

      if (deliverySnap.exists) {
        return;
      }

      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) {
        throw new Error("Transação não encontrada.");
      }

      const order = orderSnap.data();

      if (order.epayPaymentId !== paymentId) {
        throw new Error("Pagamento não corresponde à transação.");
      }

      if (eventType === "payment.paid") {
        const receivedAmount = Math.round(
          Number(data.amount_cents ?? Number(data.amount) * 100)
        );

        const expectedAmount = Math.round(Number(order.amount) * 100);

        if (
          data.currency !== "MZN" ||
          !Number.isFinite(receivedAmount) ||
          receivedAmount !== expectedAmount
        ) {
          throw new Error("Valor ou moeda do pagamento não corresponde.");
        }

        if (order.status !== "paid") {
          transaction.update(orderRef, {
            status: "paid",
            paymentStatus: "paid",
            paymentType: data.payment_method || data.payment_type || null,
            paidAt: data.paid_at || new Date(),
            updatedAt: new Date()
          });
        }
      }

      if (eventType === "payment.failed" && order.status !== "paid") {
        transaction.update(orderRef, {
          status: "failed",
          paymentStatus: "failed",
          updatedAt: new Date()
        });
      }

      if (eventType === "refund.approved") {
        transaction.update(orderRef, {
          status: "refunded",
          refundStatus: "approved",
          updatedAt: new Date()
        });
      }

      if (eventType === "refund.rejected") {
        transaction.update(orderRef, {
          refundStatus: "rejected",
          updatedAt: new Date()
        });
      }

      transaction.create(deliveryRef, {
        eventType,
        paymentId,
        orderId,
        receivedAt: new Date()
      });
    });

    return res.status(200).json({
      received: true,
      processed: true
    });

  } catch (error) {
    console.error("ePay webhook:", error.message);

    return res.status(500).json({
      error: "Não foi possível processar a notificação."
    });
  }
}

