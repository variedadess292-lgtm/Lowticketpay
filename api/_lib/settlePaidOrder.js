
import { db } from "./firebaseAdmin.js";

const KLIK_PAY_PERCENT = 10;

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export async function settlePaidOrder(orderId, paymentData = {}) {
  const orderRef = db.collection("transacoes").doc(String(orderId));

  return db.runTransaction(async transaction => {
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw new Error("Transação não encontrada.");
    }

    const order = orderSnap.data();

    if (order.settlementStatus === "settled") {
      return {
        settled: true,
        alreadySettled: true
      };
    }

    if (
      order.status === "refunded" ||
      order.status === "cancelled"
    ) {
      throw new Error("Esta transação não pode ser liquidada.");
    }

    const amount = money(order.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Valor da venda inválido.");
    }

    if (!order.sellerId) {
      throw new Error("Vendedor não identificado.");
    }

    const affiliateId = order.affiliateId || null;
    const affiliatePercent = affiliateId
      ? percent(order.affiliateCommissionPercent)
      : 0;

    const epayFeePercent = percent(
      process.env.EPAY_FEE_PERCENT ?? 7.5
    );

    if (
      affiliatePercent < 0 ||
      affiliatePercent > 100 ||
      epayFeePercent < 0 ||
      epayFeePercent > KLIK_PAY_PERCENT
    ) {
      throw new Error("Percentagens de comissão inválidas.");
    }

    if (affiliateId === order.sellerId) {
      throw new Error("O vendedor não pode receber comissão de afiliado da própria venda.");
    }

    if (KLIK_PAY_PERCENT + affiliatePercent > 100) {
      throw new Error("As comissões ultrapassam o valor da venda.");
    }

    const klikGross = money(amount * KLIK_PAY_PERCENT / 100);
    const epayFee = money(amount * epayFeePercent / 100);
    const klikNet = money(klikGross - epayFee);

    const affiliateAmount = money(
      amount * affiliatePercent / 100
    );

    const sellerAmount = money(
      amount - klikGross - affiliateAmount
    );

    const sellerWalletRef = db
      .collection("carteiras")
      .doc(order.sellerId);

    const affiliateWalletRef = affiliateId
      ? db.collection("carteiras").doc(affiliateId)
      : null;

    const platformRef = db
      .collection("liquidacoes")
      .doc(String(orderId));

    const sellerMovementRef = db
      .collection("movimentos")
      .doc(`${orderId}_seller`);

    const affiliateMovementRef = affiliateId
      ? db.collection("movimentos").doc(`${orderId}_affiliate`)
      : null;

    const sellerWalletSnap = await transaction.get(sellerWalletRef);

    const affiliateWalletSnap = affiliateWalletRef
      ? await transaction.get(affiliateWalletRef)
      : null;

    const sellerWallet = sellerWalletSnap.exists
      ? sellerWalletSnap.data()
      : {};

    const affiliateWallet = affiliateWalletSnap?.exists
      ? affiliateWalletSnap.data()
      : {};

    const now = new Date();

    transaction.set(sellerWalletRef, {
      userId: order.sellerId,
      saldoDisponivel: money(
        Number(sellerWallet.saldoDisponivel || 0) + sellerAmount
      ),
      totalRecebido: money(
        Number(sellerWallet.totalRecebido || 0) + sellerAmount
      ),
      updatedAt: now
    }, { merge: true });

    transaction.create(sellerMovementRef, {
      userId: order.sellerId,
      orderId,
      type: "sale",
      amount: sellerAmount,
      description: `Venda: ${order.productName || "Produto"}`,
      createdAt: now
    });

    if (affiliateId && affiliateAmount > 0) {
      transaction.set(affiliateWalletRef, {
        userId: affiliateId,
        saldoDisponivel: money(
          Number(affiliateWallet.saldoDisponivel || 0) + affiliateAmount
        ),
        totalRecebido: money(
          Number(affiliateWallet.totalRecebido || 0) + affiliateAmount
        ),
        updatedAt: now
      }, { merge: true });

      transaction.create(affiliateMovementRef, {
        userId: affiliateId,
        orderId,
        type: "affiliate_commission",
        amount: affiliateAmount,
        description: `Comissão de afiliado: ${order.productName || "Produto"}`,
        createdAt: now
      });
    }

    transaction.create(platformRef, {
      orderId,
      grossAmount: amount,
      klikCommissionPercent: KLIK_PAY_PERCENT,
      klikCommissionGross: klikGross,
      epayFeePercent,
      epayFee,
      klikCommissionNet: klikNet,
      affiliateId,
      affiliateCommissionPercent: affiliatePercent,
      affiliateAmount,
      sellerId: order.sellerId,
      sellerAmount,
      currency: "MZN",
      createdAt: now
    });

    transaction.update(orderRef, {
      status: "paid",
      paymentStatus: "paid",
      settlementStatus: "settled",
      settlement: {
        klikCommissionGross: klikGross,
        epayFee,
        klikCommissionNet: klikNet,
        affiliateAmount,
        sellerAmount
      },
      paidAt: paymentData.paid_at || now,
      updatedAt: now
    });

    return {
      settled: true,
      alreadySettled: false,
      sellerAmount,
      affiliateAmount,
      klikCommissionNet: klikNet,
      epayFee
    };
  });
}
