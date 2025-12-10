// server.js (CÓDIGO CONSERVANDO ESTRUCTURA ORIGINAL Y TwiML)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid'); // Se mantiene
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { PDFParse } = require('pdf-parse');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- INICIALIZACIÓN DE CLIENTES (Cambios Mínimos) ---

// 1. Cliente Supabase (Ajuste para usar Service Role Key y bypassar RLS)
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

// 2. Cliente OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3. Cliente Dialogflow (AJUSTE CRÍTICO: Leer JSON de ENV para Heroku)
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || '{}');

const sessionClient = new dialogflow.SessionsClient({
    credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
    },
});

// --- RUTA PRINCIPAL ---

app.post('/webhook', async (req, res) => {
    const userMessage = req.body.Body;
    const fromNumber = req.body.From; // Usado como senderId

    console.log(`[INICIO] Mensaje de ${fromNumber}: "${userMessage.substring(0, 50)}..."`);

    try {
        // La lógica de RAG y Dialogflow se ejecuta aquí
        const finalReply = await handleConversation(userMessage, fromNumber);
        
        // Manejo del token de transferencia a humano
        const twimlReply = (finalReply === 'HANDOFF_TO_HUMAN')
            ? "Lo siento, la consulta no pudo ser procesada. Por favor consulta directamente con la CATT."
            : finalReply;

        console.log(`[FIN] Respuesta final: "${twimlReply.substring(0, 50)}..."`);

        // --- RESPUESTA TWIML ORIGINAL DEL USUARIO ---
        const twiml = `
            <Response>
                <Message>${twimlReply}</Message>
            </Response>
        `;

        res.set('Content-Type', 'text/xml');
        res.send(twiml);
        // ------------------------------------------

    } catch (err) {
        console.error('ERROR CRÍTICO EN EL PROCESO RAG/WEBHOOK:', err);
        res.status(500).send('<Response><Message>Error interno del sistema.</Message></Response>');
    }
});

/**
 * RUTA DE INGESTA (Para Retool)
 */
app.post('/ingest-document', async (req, res) => {
    const documentId = req.body.id;
    
    if (!documentId) {
        console.error('[INGESTA ERROR] Solicitud de ingesta sin ID de documento.');
        return res.status(400).send({ message: 'Missing document ID.' });
    }

    // Ejecutar la ingesta en segundo plano
    processAndChunkDocument(documentId); 

    res.status(202).send({ message: `Ingesta iniciada para el documento ${documentId}. El procesamiento continuará en segundo plano.` });
});

app.listen(port, () => {
    console.log(`Webhook de WhatsApp + Dialogflow + RAG escuchando en el puerto ${port}`);
});

// =========================================================================
//                  LÓGICA DEL CEREBRO (FUNCIONALIDADES)
// =========================================================================

// --- ORQUESTADOR ---
async function handleConversation(query, senderId) {
    const dialogflowResponse = await checkDialogflow(query, senderId);
    console.log(`[ORQUESTADOR] Dialogflow Intent: ${dialogflowResponse.intent}`);
    
    if (dialogflowResponse.intent !== 'Default Fallback Intent') {
        return dialogflowResponse.text; 
    }
    
    console.log('[ORQUESTADOR] Dialogflow Fallback. Activando RAG...');

    const context = await getRagContext(query);
    
    if (context) {
        console.log(`[ORQUESTADOR] Contexto RAG encontrado (${context.length} chars). Llamando a OpenAI...`);
        return await generateAiResponse(query, context);
    }
    
    console.log('[ORQUESTADOR] RAG Fallback. No se encontró contexto.');
    return "HANDOFF_TO_HUMAN";
}

// --- FILTRO DIALOGFLOW ---
async function checkDialogflow(query, senderId) {
    // CRÍTICO: Usamos el número de WhatsApp como Session ID para mantener la conversación,
    // corrigiendo el uso de uuid.v4() en cada mensaje, que borraba la memoria.
    const sessionPath = sessionClient.projectAgentSessionPath(projectId, senderId.replace('whatsapp:', ''));
    
    const request = { session: sessionPath, queryInput: { text: { text: query, languageCode: 'es-ES' } } };

    try {
        const responses = await sessionClient.detectIntent(request);
        const result = responses[0].queryResult;
        const intentName = result.intent ? result.intent.displayName : 'Default Fallback Intent';
        
        return { intent: intentName, text: result.fulfillmentText, isFallback: (intentName === 'Default Fallback Intent') };
    } catch (e) {
        console.error('ERROR DIALOGFLOW:', e);
        return { intent: 'API_ERROR', text: "Error de clasificación.", isFallback: true };
    }
}

// --- BÚSQUEDA DE CONTEXTO (RAG) ---
async function getRagContext(query) {
    try {
        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small", 
            input: query,
        });
        const queryEmbedding = embeddingResponse.data[0].embedding;

        const { data: knowledgeChunks, error } = await supabase.rpc('match_knowledge', {
            query_embedding: queryEmbedding,
            match_threshold: 0.50, 
            match_count: 5,        
        });
        
        if (error) {
            console.error('ERROR RPC SUPABASE:', error);
            return null;
        }
        if (!knowledgeChunks || knowledgeChunks.length === 0) return null;

        // 3. CONSTRUIR EL CONTEXTO (Corregimos el alias y añadimos defensa)
        const context = knowledgeChunks.map(chunk => {
            // Usamos ?? '' para manejar nulls y strings vacías de forma segura.
            const title = chunk.source_title ?? 'N/A'; 
            
            // 🔥 CORRECCIÓN CLAVE: Usamos 'chunk.content' que es el alias devuelto por el RPC.
            const content = chunk.content ?? ''; 
            
            return `Título: ${title}\nContenido: ${content}`;
        }).join('\n---\n');

        return context;
    } catch (e) {
        console.error("ERROR EN RAG/SUPABASE:", e);
        return null;
    }
}

// --- GENERACIÓN DE RESPUESTA (OpenAI) ---
async function generateAiResponse(query, context) {
    const temperatureValue = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.3; 
    
    const systemPrompt = `ROL: Eres un asistente de soporte experto en trámites escolares del IPN ESCOM. 
    Tu dominio de conocimiento es **estrictamente** el IPN ESCOM y el proceso de Trabajo Terminal (TT).

    INSTRUCCIONES DE FORMATO CRÍTICAS:
    1. Sé EXTREMADAMENTE BREVE, CONCISO y FORMAL. NO utilices formato Markdown (NO uses negritas, cursivas o listas).
    2. Utiliza la menor cantidad de palabras posible, solo incluyendo los puntos más importantes de cada respuesta.

    REGLAS CRÍTICAS DE SEGURIDAD:
    1. FILTRO DE DOMINIO: Si la pregunta se refiere a procesos, trámites o carreras de CUALQUIER otra escuela o facultad (ej: FIME, UPIITA, CENAC, UNAM, etc.), tu respuesta DEBE ser el token: "HANDOFF_TO_HUMAN".
    2. FILTRO DE CONOCIMIENTO: Si el tema es ESCOM, pero la respuesta no se encuentra en el CONTEXTO disponible, tu respuesta DEBE ser el token: "HANDOFF_TO_HUMAN".

    CONTEXTO DISPONIBLE:
    ---\n${context}\n---`;

    try {
        const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL_ID || "gpt-4o-mini", 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: query },
            ],
            temperature: temperatureValue, 
            max_tokens: 300,
        });

        return response.choices[0].message.content.trim();
    } catch (e) {
        console.error('🛑 ERROR LLAMANDO A OPENAI:', e);
        return "Hubo un error al consultar la IA.";
    }
}

// --- LÓGICA DE INGESTA (ASÍNCRONA) ---

async function processAndChunkDocument(documentId) {
    console.log(`[INGESTA] INICIANDO proceso para el documento ID: ${documentId}`);
    
    // 1. OBTENER DATOS DE LA DB
    const { data: source, error: sourceError } = await supabase
        .from('content_sources')
        .select('*')
        .eq('id', documentId)
        .single();

    if (sourceError || !source) {
        console.error(`[INGESTA ERROR] No se pudo obtener la fuente de la BD:`, sourceError);
        return;
    }

    let fullText = '';
    const SOURCE_TITLE = source.title;
    
    // CASO TEXTO
    if (source.source_type === 'text') {
        fullText = source.original_content;
    } 
    // CASO ARCHIVO (Aquí está el error)
    else if (source.source_type === 'file' && source.file_url) {
        try {
            console.log(`[INGESTA DEBUG] Intentando descargar del Bucket: 'knowledge-docs'`);
            console.log(`[INGESTA DEBUG] Nombre del archivo (Path): '${source.file_url}'`);
            
            // --- CAMBIO IMPORTANTE: Capturamos el error de descarga ---
            const { data: fileData, error: downloadError } = await supabase.storage
                .from('knowledge-docs') // <--- VERIFICA QUE TU BUCKET SE LLAME ASÍ
                .download(source.file_url);

            if (downloadError) {
                console.error('[INGESTA ERROR CRÍTICO] Supabase no encontró el archivo:', downloadError);
                return; // Detenemos aquí para no crashear
            }

            if (!fileData) {
                console.error('[INGESTA ERROR] La descarga fue exitosa pero el archivo está vacío (null).');
                return;
            }

            // Si llegamos aquí, el archivo existe. Procesamos.
            const arrayBuffer = await fileData.arrayBuffer();
            const dataBuffer = Buffer.from(arrayBuffer);

            // Creamos el parser con el buffer del PDF
            const parser = new PDFParse({ data: dataBuffer });

            try {
                const result = await parser.getText();

                fullText = result.text || '';
            } finally {
                try {
                    await parser.destroy();
                } catch (e) {
                    console.warn('[INGESTA WARNING] Error al destruir parser PDF:', e);
                }
            }
        } catch (e) {
            console.error('[INGESTA ERROR] Excepción al procesar PDF:', e);
            return;
        }
    } else {
        console.log('[INGESTA] Tipo de fuente desconocido o URL vacía.');
        return;
    }

    if (!fullText || fullText.trim().length === 0) {
        console.log('[INGESTA] Texto extraído vacío. Cancelando proceso.');
        return;
    }
    
    const chunks = simpleChunker(fullText, 1000, 200);
    console.log(`[INGESTA] Texto extraído (${fullText.length} chars). Creando ${chunks.length} chunks...`);
    
    await insertChunksWithEmbeddings(documentId, SOURCE_TITLE, chunks);
    console.log(`[INGESTA] FINALIZADO EXITOSAMENTE ID: ${documentId}`);
}

function simpleChunker(text, chunkSize, overlap) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

async function insertChunksWithEmbeddings(sourceId, sourceTitle, chunks) {
    await supabase.from('content_chunks').delete().eq('source_id', sourceId);

    for (const chunk of chunks) {
        try {
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: chunk.replace(/\n/g, ' '),
            });
            const embedding = embeddingResponse.data[0].embedding;

            await supabase.from('content_chunks').insert({
                    source_id: sourceId,
                    source_title: sourceTitle,
                    chunk_content: chunk,
                    embedding: embedding,
                });
        } catch (e) {
            console.error(`[INGESTA ERROR] Fallo al procesar/insertar chunk:`, e);
        }
    }
}