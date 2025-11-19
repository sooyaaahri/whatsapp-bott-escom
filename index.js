require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid'); 
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const sessionClient = new dialogflow.SessionsClient({
    credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
    },
});

app.post('/webhook', async (req, res) => {
    const userMessage = req.body.Body;
    const fromNumber = req.body.From;

    console.log(`[INICIO] Mensaje de ${fromNumber}: "${userMessage.substring(0, 50)}..."`);

    try {
        const finalReply = await handleConversation(userMessage, fromNumber);
        
        // Manejo del token de transferencia a humano
        const twimlReply = (finalReply === 'HANDOFF_TO_HUMAN')
            ? "Lo siento, la consulta requiere asistencia humana. Un agente se pondrá en contacto pronto."
            : finalReply;

        console.log(`[FIN] Respuesta final: "${twimlReply.substring(0, 50)}..."`);

        // Respuesta TwiML XML (Formato Twilio Original)
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

    // CRÍTICO: Ejecutar la función de ingesta en segundo plano (no usar await)
    // Esto permite que Node.js responda inmediatamente a Retool.
    processAndChunkDocument(documentId); 

    // Responder inmediatamente con 202 Accepted.
    res.status(202).send({ message: `Ingesta iniciada para el documento ${documentId}. El procesamiento continuará en segundo plano.` });
});


// --- 3. Inicio del Servidor ---
app.listen(port, () => {
    console.log(`Webhook de WhatsApp + Dialogflow + RAG escuchando en el puerto ${port}`);
});


// =========================================================================
//                  LÓGICA DEL CEREBRO (CONVERSACIÓN)
// =========================================================================

/**
 * ORQUESTADOR: Maneja el flujo de Dialogflow -> RAG (Supabase + OpenAI)
 */
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


/**
 * FILTRO DE BAJA LATENCIA (Dialogflow)
 */
async function checkDialogflow(query, senderId) {
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


/**
 * BÚSQUEDA DE CONTEXTO (Supabase RPC)
 */
async function getRagContext(query) {
    
    try {
        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small", 
            input: query,
        });
        const queryEmbedding = embeddingResponse.data[0].embedding;
        console.log('[RAG] Embedding generado. Consultando RPC...');

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


/**
 * GENERACIÓN DE RESPUESTA (OpenAI con Prompt Estricto)
 */
async function generateAiResponse(query, context) {
    const systemPrompt = `Eres un experto de soporte. Responde la pregunta del cliente usando ÚNICAMENTE el CONTEXTO proporcionado. REGLA ESTRICTA: Si no puedes responder con el contexto, responde ÚNICAMENTE con la frase: "HANDOFF_TO_HUMAN". CONTEXTO DISPONIBLE: ---\n${context}\n---`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: query },
            ],
            temperature: 0.1, 
            max_tokens: 300,
        });

        const aiResponse = response.choices[0].message.content.trim();
        console.log(`[OpenAI] Respuesta generada. ¿Transferencia?: ${aiResponse === 'HANDOFF_TO_HUMAN' ? 'Sí' : 'No'}`);
        return aiResponse;

    } catch (e) {
        console.error("ERROR LLAMANDO A OPENAI:", e);
        return "Hubo un error al consultar la IA.";
    }
}

// =========================================================================
//                  LÓGICA DE INGESTA (ASÍNCRONA)
// =========================================================================

/**
 * Orquesta la descarga, fragmentación, vectorización e inserción de un documento.
 */
async function processAndChunkDocument(documentId) {
    console.log(`[INGESTA] INICIANDO proceso para el documento ID: ${documentId}`);
    
    // 1. OBTENER METADATOS Y CONTENIDO
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
    else if (source.source_type === 'file' && source.file_path) {
        try {
            console.log(`[INGESTA] Tipo 'file' detectado. Descargando desde: ${source.file_path}`);
            
            // Lógica para descargar PDF y parsear... (Asumimos que el bucket es 'knowledge-docs')
            const { data: fileData } = await supabase.storage.from('knowledge-docs').download(source.file_path);
            const dataBuffer = await fileData.arrayBuffer();
            const pdfData = await pdf(Buffer.from(dataBuffer));
            fullText = pdfData.text;
            
        } catch (downloadOrParseError) {
            console.error('[INGESTA ERROR] Fallo al descargar o parsear PDF:', downloadOrParseError);
            return;
        }
    } else {
        console.error(`[INGESTA ERROR] Tipo de fuente desconocido o ruta de archivo faltante.`);
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