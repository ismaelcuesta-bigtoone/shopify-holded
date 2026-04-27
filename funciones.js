import fetch from "node-fetch";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const HOLDED_API_KEY = process.env.HOLDED_API_KEY;
const INVOICING_URL = process.env.INVOICING_URL;
const ACCOUNTING_URL = process.env.ACCOUNTING_URL;
const BUCKET_NAME = process.env.BUCKET_NAME;

const s3 = new S3Client({ region: "us-east-1" });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const limpiezaDatos = (obj) => {
    return JSON.parse(JSON.stringify(obj, (key, value) => {
        if (typeof value === "number" && value > Number.MAX_SAFE_INTEGER) {
            return String(value);
        }
        return value;
    }));
};

export const procesarChartOfAccount = async (cuenta) => {
    cuenta = limpiezaDatos(cuenta);
    const chartName = cuenta.name;
    let chartId = null;

    const chartsResp = await fetch(`${ACCOUNTING_URL}/chartofaccounts`, {
        method: "GET",
        headers: { key: HOLDED_API_KEY }
    });
    const charts = await chartsResp.json();
    const chartExistente = Array.isArray(charts)
    ? charts.find(c => c.name?.toLowerCase() === chartName.toLowerCase())
    : null;
    
    if (chartExistente) {
        chartId = chartExistente.id;
        await fetch(`${ACCOUNTING_URL}/account/${chartId}`, {
            method: "PUT",
            headers: { key: HOLDED_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
                prefix: cuenta.prefix,
                name: chartName
            })
        });
    
    } else {
        const crearChart = await fetch(`${ACCOUNTING_URL}/account`, {
        method: "POST",
        headers: { key: HOLDED_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
            prefix: cuenta.prefix,
            name: chartName
        })
    });
        const nuevoChart = await crearChart.json();
        chartId = nuevoChart.id;
    }
    return { chartId };
}

export const procesarContacto = async (contacto, chartId) => {
    contacto = limpiezaDatos(contacto);
    const contactName = contacto.contactName || contacto.name;
    const nif = contacto.code?.trim(); 
    const email = contacto.email?.trim();
    let contactId = null;

    const resp = await fetch(`${INVOICING_URL}/contacts`, {
        method: "GET",
        headers: { key: HOLDED_API_KEY }
    });
     
    const respuestaBusqueda = await resp.json();
        const existente = Array.isArray(respuestaBusqueda) 
        ? respuestaBusqueda.find(c => nif && c.code?.trim() === nif) 
        : null;

    if (existente) {
        contactId = existente.id;
        console.log(`Actualizando contacto existente: ${contactId}`);
        
        await fetch(`${INVOICING_URL}/contacts/${contactId}`, {
            method: "PUT",
            headers: { key: HOLDED_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ 
                name: contactName,
                code: nif || existente.code,
                email: email || existente.email,
                clientRecord: chartId 
            })
        });
    } else {
        console.log("Creando nuevo contacto...");
        const crearContacto = await fetch(`${INVOICING_URL}/contacts`, {
            method: "POST",
            headers: { key: HOLDED_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
                name: contactName,
                code: nif,
                email: email,
                type: "client",
                isperson: true,
                clientRecord: chartId
            })
        });
        
        const nuevoContacto = await crearContacto.json();
        contactId = nuevoContacto.id || nuevoContacto.data?.id; 
    }
    return { contactId };
};

export const procesarProducto = async (producto) => {
    producto = limpiezaDatos(producto);
    const productId = String(producto.id || Date.now()); 
    const sku = producto.variants?.[0]?.sku || producto.sku || productId;
    const price = Number(producto.variants?.[0]?.price || producto.price || 0);
    const title = producto.title || producto.name;

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `productos/producto-${productId}.json`,
        Body: JSON.stringify(producto),
        ContentType: "application/json"
    }));
    
    const search = await fetch(`${INVOICING_URL}/products?reference=${sku}`, {
        headers: { key: HOLDED_API_KEY }
    });
    const found = await search.json();
    if (!Array.isArray(found) || found.length === 0) {
        await fetch(`${INVOICING_URL}/products`, {
            method: "POST",
            headers: { key: HOLDED_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
                name: title,
                reference: sku,
                price
            })
        });
    } else {
        const holdedId = found[0].id;
        await fetch(`${INVOICING_URL}/products/${holdedId}`, {
            method: "PUT",
            headers: { key: HOLDED_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
                name: title,
                reference: sku,
                price
            })
        });
    }

    await dynamo.send(new PutCommand({
        TableName: "TablaProductos",
        Item: {
            sku: sku,
            id: productId,
            name: title,
            price,
            updateDate: new Date().toISOString()
        }
    }));
    return { status: "ok", productId };
};

export const procesarPedidos = async (datos) => {
    datos = limpiezaDatos(datos);
    const pedidoId = String(datos.id || Date.now());
    const cuenta = datos.cuenta || {};
    const contacto = datos.contacto || {};

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `pedidos/pedido-${pedidoId}.json`,
        Body: JSON.stringify(datos),
        ContentType: "application/json"
    }));

    const { chartId } = await procesarChartOfAccount(cuenta);
    const { contactId } = await procesarContacto(contacto, chartId);

    const productosaHolded = [];
    for (const item of datos.line_items) {
        const sku = item.sku || String(item.product_id || item.id);
        await procesarProducto({
            id: item.product_id || item.id,
            title: item.title || item.name,
            sku: sku,
            variants: [{ sku, price: item.price }]
        });

        productosaHolded.push({
            name: item.title || item.name,
            units: item.quantity,
            price: item.price,
            subtotal: Number(item.price * item.quantity),
            accountingAccountId: chartId
        });

        await dynamo.send(new PutCommand({
            TableName: "TablaPedidos",
            Item: {
                pedidoId,
                sku,
                productId: String(item.product_id || item.id),
                name: item.title || item.name,
                price: Number(item.price),
                quantity: item.quantity,
                updateDate: new Date().toISOString()
            }
        }));
    }

    const facturasResp = await fetch(`${INVOICING_URL}/documents/invoice`, {
        headers: { key: HOLDED_API_KEY }
    });
    const facturas = await facturasResp.json();
    const facturaExistente = Array.isArray(facturas) 
        ? facturas.find(f => String(f.customId) === pedidoId) 
        : null;

    const invoiceData = {
        contactId,
        customId: pedidoId,
        date: Math.floor(Date.now() / 1000),
        items: productosaHolded
    };

    let invoiceResponse;
    if (facturaExistente) {
        invoiceResponse = await fetch(`${INVOICING_URL}/documents/invoice/${facturaExistente.id}`, {
            method: "PUT",
            headers: { key: HOLDED_API_KEY, 'Content-Type': "application/json" },
            body: JSON.stringify(invoiceData)
        });
    } else {
        invoiceResponse = await fetch(`${INVOICING_URL}/documents/invoice`, {
            method: "POST",
            headers: { key: HOLDED_API_KEY, 'Content-Type': "application/json" },
            body: JSON.stringify(invoiceData)
        });
    }

    if (!invoiceResponse.ok) {
        const errorText = await invoiceResponse.text();
        throw new Error(`Error en factura Holded: ${errorText}`);
    }
    return await invoiceResponse.json();
};