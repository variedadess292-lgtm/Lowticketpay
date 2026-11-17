
import { Storage } from "megajs";
import multer from "multer";
import admin from "firebase-admin";
import crypto from "node:crypto";

/* CONFIGURAÇÃO DA VERCEL */

export const config = {
    api: {
        bodyParser: false
    }
};

/* FIREBASE ADMIN */

function getFirebaseAdmin() {

    if (!admin.apps.length) {

        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

        const privateKey = process.env.FIREBASE_PRIVATE_KEY
            ?.replace(/\\n/g, "\n");

        if (!projectId || !clientEmail || !privateKey) {
            throw new Error(
                "Variáveis do Firebase Admin não configuradas."
            );
        }

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId,
                clientEmail,
                privateKey
            })
        });
    }

    return admin;
}

/* FIRESTORE */

function getDatabase() {
    return getFirebaseAdmin().firestore();
}

/* MULTER */

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 3 * 1024 * 1024,
        files: 1
    }
}).single("file");

/* RECEBER FICHEIRO */

function parseUpload(req, res) {

    return new Promise((resolve, reject) => {

        upload(req, res, error => {

            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

/* FORMATOS PERMITIDOS */

const allowedTypes = {
    image: [
        "image/jpeg",
        "image/png",
        "image/webp"
    ],

    pdf: [
        "application/pdf"
    ]
};

/* VALIDAR CONTEÚDO */

function validateFile(buffer, kind) {

    if (!buffer || buffer.length < 8) {
        return false;
    }

    const header = buffer.subarray(0, 12);

    if (kind === "pdf") {
        return header.subarray(0, 5).toString() === "%PDF-";
    }

    const jpeg =
        header[0] === 0xFF &&
        header[1] === 0xD8 &&
        header[2] === 0xFF;

    const png = header
        .subarray(0, 8)
        .equals(
            Buffer.from([
                137, 80, 78, 71,
                13, 10, 26, 10
            ])
        );

    const webp =
        header.subarray(0, 4).toString() === "RIFF" &&
        header.subarray(8, 12).toString() === "WEBP";

    return jpeg || png || webp;
}

/* LIGAÇÃO AO MEGA */

let megaStoragePromise = null;

async function getMegaStorage() {

    const email = process.env.MEGA_EMAIL;
    const password = process.env.MEGA_PASSWORD;

    if (!email || !password) {
        throw new Error(
            "Variáveis de acesso ao MEGA não configuradas."
        );
    }

    if (!megaStoragePromise) {

        megaStoragePromise = (async () => {

            const storage = new Storage({
                email,
                password
            });

            await storage.ready;

            return storage;

        })().catch(error => {

            megaStoragePromise = null;

            throw error;
        });
    }

    return megaStoragePromise;
}

/* ENCONTRAR OU CRIAR PASTA */

async function getUserFolder(storage, uid) {

    let rootFolder = storage.root.children.find(
        item =>
            item.name === "LOWTICKETPAY" &&
            item.directory
    );

    if (!rootFolder) {
        rootFolder = await storage.root.mkdir(
            "LOWTICKETPAY"
        );
    }

    let userFolder = rootFolder.children.find(
        item =>
            item.name === uid &&
            item.directory
    );

    if (!userFolder) {
        userFolder = await rootFolder.mkdir(uid);
    }

    return userFolder;
}

/* RESPOSTAS JSON */

function sendError(res, status, message) {

    return res.status(status).json({
        success: false,
        message
    });
}

/* API PRINCIPAL */

export default async function handler(req, res) {

    res.setHeader("Cache-Control", "no-store");

    /* MÉTODO */

    if (req.method !== "POST") {

        res.setHeader("Allow", "POST");

        return sendError(
            res,
            405,
            "Método não permitido."
        );
    }

    try {

        /* FIREBASE */

        const firebaseAdmin = getFirebaseAdmin();
        const db = getDatabase();

        /* AUTENTICAÇÃO */

        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {

            return sendError(
                res,
                401,
                "Sessão não autorizada."
            );
        }

        const token = authorization.slice(7);

        const decoded = await firebaseAdmin
            .auth()
            .verifyIdToken(token);

        /* RECEBER FICHEIRO */

        await parseUpload(req, res);

        if (!req.file) {

            return sendError(
                res,
                400,
                "Seleciona um ficheiro."
            );
        }

        const file = req.file;
        const kind = req.body?.kind;

        /* VALIDAR CATEGORIA */

        if (!["image", "pdf"].includes(kind)) {

            return sendError(
                res,
                400,
                "Tipo de ficheiro inválido."
            );
        }

        /* VALIDAR FORMATO */

        if (!allowedTypes[kind].includes(file.mimetype)) {

            return sendError(
                res,
                400,
                "Formato de ficheiro não permitido."
            );
        }

        /* VALIDAR CONTEÚDO REAL */

        if (!validateFile(file.buffer, kind)) {

            return sendError(
                res,
                400,
                "O conteúdo do ficheiro é inválido."
            );
        }

        /* CONECTAR AO MEGA */

        const storage = await getMegaStorage();

        const userFolder = await getUserFolder(
            storage,
            decoded.uid
        );

        /* IDENTIFICADOR */

        const fileId = crypto.randomUUID();

        let extension = ".jpg";

        if (kind === "pdf") {
            extension = ".pdf";
        } else if (file.mimetype === "image/png") {
            extension = ".png";
        } else if (file.mimetype === "image/webp") {
            extension = ".webp";
        }

        const filename = fileId + extension;

        /* ENVIAR FICHEIRO */

        const uploaded = await userFolder.upload(
            {
                name: filename,
                size: file.size
            },
            file.buffer
        ).complete;

        if (!uploaded || !uploaded.nodeId) {
            throw new Error(
                "O MEGA não devolveu o identificador do ficheiro."
            );
        }

        /* REGISTAR NO FIRESTORE */

        await db
            .collection("privateUploads")
            .doc(fileId)
            .set({

                fileId,

                ownerId: decoded.uid,

                kind,

                megaNodeId: uploaded.nodeId,

                filename,

                createdAt:
                    firebaseAdmin.firestore.FieldValue
                        .serverTimestamp()

            });

        /* RESPOSTA PARA PRODUTOS.HTML */

        return res.status(200).json({

            success: true,

            fileId

        });

    } catch (error) {

        console.error(
            "LOWTICKETPAY UPLOAD ERROR:",
            error
        );

        if (error.code === "LIMIT_FILE_SIZE") {

            return sendError(
                res,
                413,
                "O ficheiro ultrapassa o limite de 3 MB."
            );
        }

        if (error.code === "LIMIT_FILE_COUNT") {

            return sendError(
                res,
                400,
                "Envia apenas um ficheiro de cada vez."
            );
        }

        if (error.code === "LIMIT_UNEXPECTED_FILE") {

            return sendError(
                res,
                400,
                "Campo de ficheiro inválido."
            );
        }

        if (
            error.code === "auth/argument-error" ||
            error.code === "auth/invalid-id-token" ||
            error.code === "auth/id-token-expired"
        ) {

            return sendError(
                res,
                401,
                "Sessão expirada. Inicia sessão novamente."
            );
        }

        return sendError(
            res,
            500,
            "Falha no servidor durante o envio do ficheiro."
        );
    }
}
