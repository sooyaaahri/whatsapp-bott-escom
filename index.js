// server.js (CÓDIGO FINAL DE PRODUCCIÓN)
const express = require('express');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const pdf = require('pdf-parse'); 
require('dotenv').config(); 

// --- 1. Inicialización de Clientes y Configuración ---
const app = express();
const port = process.env.PORT || 3000;

// Configuración de credenciales Supabase (usamos SERVICE_ROLE como fallback para RLS)
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Configuración de Dialogflow
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
// El JSON de credenciales se parsea de la variable de entorno (para Heroku)
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || '{}');
const sessionClient = new dialogflow.SessionsClient({
    credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
    },
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


// --- 2. Rutas del Servidor ---

/**
 * 2.1 WEBHOOK DE WHATSAPP (Conversación Principal)
 */
app.post('/webhook', async (req, res) => {
    const userMessage = req.body.Body;
    const fromNumber = req.body.From;

    console.log(`[INICIO] Mensaje de ${fromNumber}: "${userMessage.substring(0, 50)}..."`);

    try {
        const finalReply = await handleConversation(userMessage, fromNumber);
        
        const twimlReply = (finalReply === 'HANDOFF_TO_HUMAN')
            ? "Lo siento, la consulta requiere asistencia humana. Un agente se pondrá en contacto pronto."
            : finalReply;

        console.log(`[FIN] Respuesta final: "${twimlReply.substring(0, 50)}..."`);

        const twiml = `<Response><Message>${twimlReply}</Message></Response>`;

        res.set('Content-Type', 'text/xml');
        res.send(twiml);

    } catch (err) {
        console.error('ERROR CRÍTICO EN EL PROCESO RAG/WEBHOOK:', err);
        res.status(500).send('<Response><Message>Error interno del sistema.</Message></Response>');
    }
});

/**
 * 2.2 RUTA DE INGESTA (Disparada por Retool al subir un documento)
 */
app.post('/ingest-document', async (req, res) => {
    const documentId = req.body.id;
    
    if (!documentId) {
        console.error('[INGESTA ERROR] Solicitud de ingesta sin ID de documento.');
        return res.status(400).send({ message: 'Missing document ID.' });
    }

    // Ejecutar la ingesta en segundo plano (no usar await)
    processAndChunkDocument(documentId); 

    res.status(202).send({ message: `Ingesta iniciada para el documento ${documentId}. El procesamiento continuará en segundo plano.` });
});


// --- 3. Inicio del Servidor ---
app.listen(port, () => {
    console.log(`Webhook de WhatsApp + Dialogflow + RAG escuchando en el puerto ${port}`);
});


// =========================================================================
//                  LÓGICA DEL CEREBRO (CONVERSACIÓN)
// =========================================================================

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


async function checkDialogflow(query, senderId) {
    // Nota: El Session ID se toma del número de WhatsApp para mantener la memoria.
    const sessionPath = sessionClient.projectAgentSessionPath(projectId, senderId.replace('whatsapp:', ''));
    
    const request = { 
        session: sessionPath, 
        queryInput: { 
            text: { text: query, languageCode: 'es-ES' } 
        } 
    };

    try {
        const responses = await sessionClient.detectIntent(request);
        const result = responses[0].queryResult;
        const intentName = result.intent ? result.intent.displayName : 'Default Fallback Intent';
        
        return { 
            intent: intentName, 
            text: result.fulfillmentText, 
            isFallback: (intentName === 'Default Fallback Intent') 
        };
    } catch (e) {
        console.error('ERROR DIALOGFLOW:', e);
        return { intent: 'API_ERROR', text: "Error de clasificación.", isFallback: true };
    }
}


async function getRagContext(query) {
    
    try {
        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small", 
            input: query,
        });
        const queryEmbedding = embeddingResponse.data[0].embedding;
        console.log('[RAG] Embedding generado. Consultando RPC...');

        // CRÍTICO: Llamada a la función PostgreSQL para la búsqueda vectorial
        const { data: knowledgeChunks, error } = await supabase.rpc('match_knowledge', {
            query_embedding: queryEmbedding,
            match_threshold: 0.75, 
            match_count: 3,        
        });
        
        if (error) {
            console.error('ERROR RPC SUPABASE:', error);
            return null;
        }

        if (!knowledgeChunks || knowledgeChunks.length === 0) {
            console.log('[RAG] RPC OK. Resultado: 0 chunks encontrados.');
            return null;
        }

        console.log(`[RAG] RPC OK. Chunks encontrados: ${knowledgeChunks.length}`);

        const context = knowledgeChunks.map(chunk => 
            `Título: ${chunk.source_title}\nContenido: ${chunk.content}`
        ).join('\n---\n');

        return context;

    } catch (e) {
        console.error("ERROR EN RAG/SUPABASE:", e);
        return null;
    }
}


async function generateAiResponse(query, context) {
    const temperatureValue = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.3; 
    
    const systemPrompt = `
ROL: Eres un experto de soporte. Responde la pregunta del cliente usando ÚNICAMENTE el CONTEXTO proporcionado.

REGLA CRÍTICA:
1. Si la información del contexto indica una negación o restricción (ej. "no es responsable", "no aplica", "solo aplica a X"), ESA ES LA RESPUESTA VÁLIDA. Fórmulala directamente al usuario. No respondas HANDOFF.
2. Si la información es insuficiente, contradictoria, o no existe en el contexto, y la pregunta no se puede responder, responde ÚNICAMENTE con la frase: "HANDOFF_TO_HUMAN".

CONTEXTO DISPONIBLE:
---
${context}
---
`;

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

        const aiResponse = response.choices[0].message.content.trim();
        console.log(`[OpenAI] Respuesta generada. ¿Transferencia?: ${aiResponse === 'HANDOFF_TO_HUMAN' ? 'Sí' : 'No'}`);
        return aiResponse;

    } catch (e) {
        console.error('🛑 ERROR OPENAI CHAT COMPLETION:', e.response?.data || e.message || e);
        return "Hubo un error al consultar la IA.";
    }
}

// =========================================================================
//                  LÓGICA DE INGESTA (ASÍNCRONA)
// =========================================================================

async function processAndChunkDocument(documentId) {
    console.log(`[INGESTA] INICIANDO proceso para el documento ID: ${documentId}`);
    
    const { data: source, error: sourceError } = await supabase
        .from('content_sources')
        .select('*')
        .eq('id', documentId)
        .single();

    if (sourceError || !source) {
        console.error(`[INGESTA ERROR] No se pudo obtener la fuente ${documentId}:`, sourceError);
        return;
    }

    let fullText = '';
    const SOURCE_TITLE = source.title;
    
    if (source.source_type === 'text') {
        fullText = source.original_content;
    } 
    else if (source.source_type === 'file' && source.file_url) {
        try {
            console.log(`[INGESTA] Tipo 'file' detectado. Descargando desde: ${source.file_url}`);
            
            // Lógica para descargar PDF y parsear... 
            // Se usa el bucket 'knowledge-docs' como ejemplo.
            const { data: fileData } = await supabase.storage.from('knowledge-docs').download(source.file_url);
            const dataBuffer = await fileData.arrayBuffer();
            const pdfData = await pdf(Buffer.from(dataBuffer));
            fullText = pdfData.text;
            
        } catch (downloadOrParseError) {
            console.error('[INGESTA ERROR] Fallo al descargar o parsear PDF:', downloadOrParseError);
            return;
        }
    } else {
        console.error(`[INGESTA ERROR] Tipo de fuente desconocido o URL de archivo faltante.`);
        return;
    }

    if (!fullText) return console.log('[INGESTA] Texto vacío. Cancelando.');
    
    // 2. CHUNKING (Fragmentación del Texto)
    const chunks = simpleChunker(fullText, 1000, 200);
    console.log(`[INGESTA] Texto dividido en ${chunks.length} fragmentos.`);
    
    // 3. GENERACIÓN DE EMBEDDINGS E INSERCIÓN
    await insertChunksWithEmbeddings(documentId, SOURCE_TITLE, chunks);
    
    console.log(`[INGESTA] FINALIZADO el proceso para el documento ID: ${documentId}`);
}

function simpleChunker(text, chunkSize, overlap) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

async function insertChunksWithEmbeddings(sourceId, sourceTitle, chunks) {
    const { error: deleteError } = await supabase.from('content_chunks').delete().eq('source_id', sourceId);
    if (deleteError) console.error('[INGESTA ERROR] No se pudieron eliminar chunks viejos:', deleteError);
    
    console.log(`[INGESTA] Eliminados chunks previos para source_id: ${sourceId}`);

    for (const [index, chunk] of chunks.entries()) {
        try {
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: chunk.replace(/\n/g, ' '),
            });
            const embedding = embeddingResponse.data[0].embedding;

            const { error: insertError } = await supabase
                .from('content_chunks')
                .insert({
                    source_id: sourceId,
                    source_title: sourceTitle,
                    chunk_content: chunk,
                    embedding: embedding,
                });

            if (insertError) throw insertError;
            
            console.log(`[INGESTA] Chunk ${index + 1}/${chunks.length} insertado correctamente.`);
            
        } catch (e) {
            console.error(`[INGESTA ERROR] Fallo al procesar/insertar chunk ${index + 1}:`, e);
        }
    }
}