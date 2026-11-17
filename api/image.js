
import { Storage } from "megajs";
import admin from "firebase-admin";

// =====================================
// FIREBASE ADMIN
// =====================================

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !privateKey
  ) {
    throw new Error("Variáveis do Firebase não configuradas.");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey.replace(/\\n/g, "\n")
    })
  });
}

const db = admin.firestore();

// =====================================
// MEGA STORAGE
// =====================================

let megaPromise = null;

async function getMegaStorage() {
  if (!process.env.MEGA_EMAIL || !process.env.MEGA_PASSWORD) {
    throw new Error("Credenciais MEGA não configuradas.");
  }

  if (!megaPromise) {
    const storage = new Storage({
      email: process.env.MEGA_EMAIL,
      password: process.env.MEGA_PASSWORD
    });

    megaPromise = storage.ready.then(() => storage);
  }

  return megaPromise;
}

// =====================================
// PROCURAR FICHEIRO NO MEGA
// =====================================

function findMegaFile(storage, nodeId) {
  const queue = [...(storage.root.children || [])];
  const visited = new Set();

  while (queue.length > 0) {
    const node = queue.shift();

    if (!node || visited.has(node.nodeId)) {
      continue;
    }

    visited.add(node.nodeId);

    if (node.nodeId === nodeId) {
      return node;
    }

    if (node.children && node.children.length > 0) {
      queue.push(...node.children);
    }
  }

  return null;
}

// =====================================
// API IMAGE
// =====================================

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      message: "Método não permitido."
    });
  }

  try {
    const fileId = req.query.fileId;

    // Validar ID
    if (
      typeof fileId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(fileId)
    ) {
      return res.status(400).json({
        success: false,
        message: "ID de imagem inválido."
      });
    }

    // Procurar registo no Firestore
    const doc = await db
      .collection("privateUploads")
      .doc(fileId)
      .get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: "Imagem não encontrada."
      });
    }

    const fileData = doc.data();

    // Confirmar que é uma imagem
    if (
      fileData.kind !== "image" ||
      !fileData.megaNodeId ||
      !fileData.filename
    ) {
      return res.status(404).json({
        success: false,
        message: "Ficheiro não é uma imagem."
      });
    }

    // Ligar ao MEGA
    const storage = await getMegaStorage();

    // Procurar imagem pelo nodeId
    const megaFile = findMegaFile(
      storage,
      fileData.megaNodeId
    );

    if (!megaFile) {
      return res.status(404).json({
        success: false,
        message: "Imagem não encontrada no armazenamento."
      });
    }

    // Descarregar imagem
    const buffer = await megaFile.downloadBuffer();

    // Identificar formato
    const extension = fileData.filename
      .split(".")
      .pop()
      .toLowerCase();

    const mimeTypes = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp"
    };

    const contentType = mimeTypes[extension];

    if (!contentType) {
      return res.status(415).json({
        success: false,
        message: "Formato de imagem não suportado."
      });
    }

    // Enviar imagem ao navegador
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600"
    );
    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    return res.status(200).send(buffer);

  } catch (error) {
    console.error("Erro na API image:", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao carregar imagem."
    });
  }
}
