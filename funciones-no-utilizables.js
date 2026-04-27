/*import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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

export const procesarCuentas = async (account) => {
    account = limpiezaDatos(account);
    const chartName = account.name;         
    const contactName = account.contactName;
    let chartId = null;
    let contactId = null;

    const chartsResp = await fetch(`${ACCOUNTING_URL}/chartofaccounts`, {
        method: "GET",
        headers: { key: HOLDED_API_KEY }
    });
    const charts = await chartsResp.json();
    const chart = charts.find(c => c.name?.toLowerCase() === chartName.toLowerCase());
    if (chart) {
        chartId = chart.id;
    } else {
        const crearChart = await fetch(`${ACCOUNTING_URL}/account`, {
            method: "POST",
            headers: {
                key: HOLDED_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                prefix: account.prefix || 4300,
                name: chartName
            })
        });
        const nuevoChart = await crearChart.json();
        chartId = nuevoChart.id;
    }

    const nif = account.nif?.trim();
    let contacto = null;
    if (nif) {
        const resp = await fetch(`${INVOICING_URL}/contacts/${nif}`, {
            method: "GET",
            headers: { key: HOLDED_API_KEY }
        });

        if (resp.ok) {
            contacto = await resp.json();
            contactId = contacto.id;
        }
    }

    if (!contacto) {
        const crearContacto = await fetch(`${INVOICING_URL}/contacts`, {
            method: "POST",
            headers: {
                key: HOLDED_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                id: nif,
                name: contactName,
                email: account.email || "",
                type: "client",
                isperson: true,
                clientRecord: chartId
            })
        });
        const nuevoContacto = await crearContacto.json();
        contactId = nuevoContacto.id;
    }
    return { chartId, contactId };
};

export const procesarProducto = async (product) => {
    product = limpiezaDatos(product);
    const productId = String(product.id);
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `productos/producto-${product.id}.json`,
        Body: JSON.stringify(product),
        ContentType: "application/json"
    }));

    const sku = product.variants?.[0]?.sku || String(product.id);
    const price = Number(product.variants?.[0]?.price || 0);
    const title = product.title;

    const search = await fetch(`${INVOICING_URL}/products?reference=${sku}`, {
        headers: { key: HOLDED_API_KEY }
    });
    const found = await search.json();
    if (!Array.isArray(found) || found.length === 0) {
        await fetch(`${INVOICING_URL}/products`, {
            method: "POST",
            headers: {
                key: HOLDED_API_KEY,
                "Content-Type": "application/json"
            },
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
            headers: {
                key: HOLDED_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name: title,
                price
            })
        });
    }
    await dynamo.send(new PutCommand({
        TableName: "TablaProductos",
        Item: {
            sku,
            name: title,
            price,
            updateDate: new Date().toISOString()
        }
    }));
    return { status: "ok", productId };
};

export const procesarPedidos = async (data) => {
    data = limpiezaDatos(data);
    const nif = data.nif?.trim();
    const orderId = String(data.id || Date.now());
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `pedidos/pedido-${orderId}.json`,
        Body: JSON.stringify(data),
        ContentType: "application/json"
    }));
    const orderDB = await dynamo.send(new GetCommand({
        TableName: "TablaPedidos",
        Key: { pedidoId: orderId }
    }));

    const existingInvoiceId = orderDB.Item?.invoiceId || null;
    const { chartId, contactId } = await procesarCuentas(data);

    if (!Array.isArray(data.line_items)) {
        throw new Error("Order missing line_items");
    }

    const itemsForHolded = [];
    for (const item of data.line_items) {
        const sku = item.sku || String(item.id);
        const productDB = await dynamo.send(new GetCommand({
            TableName: "TablaProductos",
            Key: { sku }
        }));

        if (!productDB.Item) {
            await procesarProducto({
                id: item.product_id || item.id,
                title: item.title,
                variants: [
                    {
                        sku,
                        price: item.price
                    }
                ]
            });
        }
        itemsForHolded.push({
            name: item.title,
            units: item.quantity,
            subtotal: Number(item.price) * item.quantity,
            accountingAccountId: chartId
        });
    }
    let finalInvoiceId = existingInvoiceId;
    if (!existingInvoiceId) {
        const createInvoice = await fetch(`${INVOICING_URL}/documents/invoice`, {
            method: "POST",
            headers: { 'key': HOLDED_API_KEY, 'Content-Type': "application/json" },
            body: JSON.stringify({
                contactCode: nif,
                contactId,
                date: Math.floor(Date.now() / 1000),
                docType: "invoice",
                items: itemsForHolded
            })
        });
        if (!createInvoice.ok) {
            throw new Error(`Error creating invoice: ${await createInvoice.text()}`);
        }
        const invoice = await createInvoice.json();
        finalInvoiceId = invoice.id;

    } else {
        const updateInvoice = await fetch(`${INVOICING_URL}/documents/invoice/${existingInvoiceId}`, {
            method: "PUT",
            headers: { 'key': HOLDED_API_KEY, 'Content-Type': "application/json" },
            body: JSON.stringify({
                contactCode: nif,
                contactId,
                date: Math.floor(Date.now() / 1000),
                items: itemsForHolded
            })
        });

        if (!updateInvoice.ok) {
            throw new Error(`Error updating invoice: ${await updateInvoice.text()}`);
        }
    }
    await dynamo.send(new PutCommand({
        TableName: "TablaPedidos",
        Item: {
            pedidoId: orderId,
            invoiceId: finalInvoiceId,
            nif,
            contactId,
            chartId,
            updateDate: new Date().toISOString()
        }
    }));
    return { status: "ok", pedidoId: orderId, invoiceId: finalInvoiceId };
};*/