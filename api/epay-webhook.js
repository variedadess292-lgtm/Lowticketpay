
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./_lib/firebaseAdmin.js";
import { settlePaidOrder } from "./_lib/settlePaidOrder.js";

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
  if (
    typeof expected !== "string" ||
    typeof received !== "string" ||
    !/^[a-f0-9]+$/i.test(received) ||
    expected.length !== received.length
  ) {
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

    if (eventType === "refund.approved" || eventType === "refund.rejected") {
      console.warn("Evento de reembolso recebido; reversão financeira ainda não implementada.");

      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Reversão financeira ainda não implementada."
      });
    }

    if (!["payment.paid", "payment.failed"].includes(eventType)) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    const data = payload.data || payload;

    const paymentId = data.id;
    const orderId = data.external_reference;

    if (!paymentId || !orderId) {
      return res.status(400).json({
        error: "Referência de pagamento inválida."
      });
    }

    const deliveryId =
      req.headers["x-epay-delivery"] ||
      payload.id ||
      `${paymentId}_${eventType}`;

    const deliveryRef = db
      .collection("epayWebhookEvents")
      .doc(String(deliveryId));

    const existingDelivery = await deliveryRef.get();

    if (existingDelivery.exists) {
      return res.status(200).json({
        received: true,
        duplicate: true
      });
    }

    const orderRef = db
      .collection("transacoes")
      .doc(String(orderId));

    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      throw new Error("Transação não encontrada.");
    }

    const order = orderSnap.data();

    if (order.epayPaymentId !== paymentId) {
      throw new Error("Pagamento não corresponde à transação.");
    }

    if (eventType === "payment.paid") {
      const receivedAmount = Math.round(
        Number(
          data.amount_cents ??
          Number(data.amount) * 100
        )
      );

      const expectedAmount = Math.round(
        Number(order.amount) * 100
      );

      if (
        data.currency !== "MZN" ||
        !Number.isFinite(receivedAmount) ||
        receivedAmount !== expectedAmount
      ) {
        throw new Error("Valor ou moeda do pagamento não corresponde.");
      }

      await settlePaidOrder(String(orderId), {
        paid_at: data.paid_at || null,
        payment_method: data.payment_method || data.payment_type || null
      });
    }

    if (eventType === "payment.failed") {
      await db.runTransaction(async transaction => {
        const freshDelivery = await transaction.get(deliveryRef);
        const freshOrder = await transaction.get(orderRef);

        if (freshDelivery.exists) return;

        if (!freshOrder.exists) {
          throw new Error("Transação não encontrada.");
        }

        if (freshOrder.data().status !== "paid") {
          transaction.update(orderRef, {
            status: "failed",
            paymentStatus: "failed",
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
    }

    await deliveryRef.create({
      eventType,
      paymentId,
      orderId,
      receivedAt: new Date()
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
