
import { db } from "./_lib/firebaseAdmin.js";

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({
            error: "Método não permitido."
        });
    }

    try {
        const productId = req.query.id;

        if (
            typeof productId !== "string" ||
            !productId.trim()
        ) {
            return res.status(400).json({
                error: "Identificação do produto inválida."
            });
        }

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
            product.status === "Desactivado" ||
            product.status === "Desativado" ||
            product.status === "inativo"
        ) {
            return res.status(404).json({
                error: "Este produto não está disponível."
            });
        }

        const price = Number(product.preco);

        if (!Number.isFinite(price) || price <= 0) {
            return res.status(400).json({
                error: "Preço do produto inválido."
            });
        }

        let imagem = null;

        if (product.imageFileId) {
            imagem = "/api/image?fileId=" +
                encodeURIComponent(product.imageFileId);
        } else if (product.imageUrl || product.imagem) {
            imagem = product.imageUrl || product.imagem;
        }

        return res.status(200).json({
            product: {
                id: productSnap.id,
                nome: product.nome || "Produto KLIKPay",
                descricao: product.descricao || "",
                preco: price,
                imagem
            }
        });

    } catch (error) {
        console.error("Product info error:", error);

        return res.status(500).json({
            error: "Não foi possível carregar o produto."
        });
    }
}
