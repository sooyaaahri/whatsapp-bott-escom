require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid'); 
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const languageCode = 'es';

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const sessionClient = new dialogflow.SessionsClient({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

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

        const twiml = `
            <Response>
                <Message>${twimlReply}</Message>
            </Response>
        `;

        res.set('Content-Type', 'text/xml');
        res.send(twiml);

    } catch (err) {
        console.error('ERROR CRÍTICO EN EL PROCESO RAG/WEBHOOK:', err);
        res.status(500).send('<Response><Message>Error interno del sistema.</Message></Response>');
    }
});

app.listen(port, () => {
    console.log(`Webhook de WhatsApp + Dialogflow + RAG escuchando en el puerto ${port}`);
});


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