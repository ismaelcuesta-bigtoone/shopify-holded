import dotenv from "dotenv";
const envConfig = dotenv.config();

import express from "express";
import serverless from "serverless-http";
import { procesarPedidos, procesarProducto } from "./funciones.js";

const app = express();
app.use(express.json());

app.post("/webhook-shopify", async (req, res) => {
    const topic = req.headers["x-shopify-topic"];
    const datos = req.body;

    if (!topic) {
        return res.status(400).json({ error: "Fallo en cabecera: x-shopify-topic" });
    }

    let resultado;
    if (topic.startsWith("orders/")) {
        console.log("Procesando Pedido...");
        resultado = await procesarPedidos(datos);
    } else if (topic.startsWith("products/")) {
        console.log("Procesando Producto...");
        resultado = await procesarProducto(datos);
    } else {
        return res.status(400).json({ error: `Topic no soportado: ${topic}` });
    }

    console.log("Proceso completado con éxito");
    res.status(200).json({
        mensaje: "Procesado correctamente",
        resultado
    });
})

app.listen(3000, () => { 
    console.log("Servidor Express en http://localhost:3000");
});

export const handler = serverless(app);