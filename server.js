require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3747;
const upload = multer({ dest: path.join(os.tmpdir(), 'leonamos-uploads') });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_KEY = process.env.GEMINI_KEY;
const GROQ_KEY = process.env.GROQ_KEY;
const VAULT = process.env.VAULT_PATH || path.join(os.homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Second Brain');
const TEMAS = ['Liderança & Gestão', 'Marketing & Vendas', 'Estratégia', 'Filosofia & Mentalidade', 'Copywriting', 'IA & Prompts', 'Aprendizagem', 'Autoconhecimento'];
const MOCS = `[[MOC - Autoconhecimento]]\n[[MOC - Copywriting]]\n[[MOC - Design]]\n[[MOC - Estratégia]]\n[[MOC - Filosofia & Mentalidade]]\n[[MOC - IA & Prompts]]\n[[MOC - Liderança & Gestão]]\n[[MOC - Literatura]]\n[[MOC - Marketing & Vendas]]`;

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function salvarNoObsidian(caminho, conteudo) {
  if (!fs.existsSync(VAULT)) return; // sem vault local (Railway), ignora silenciosamente
  const dir = path.dirname(caminho);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(caminho, conteudo, 'utf8');
}

function sanitizar(nome) {
  return nome.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
}

function limparNota(conteudo) {
  return conteudo
    .replace(/^---[\s\S]*?---\n?/m, '')          // remove frontmatter YAML
    .replace(/\*\*Origem:\*\*[^\n]*/g, '')        // remove campo Origem
    .replace(/\*\*Relacionado:\*\*[^\n]*/g, '')   // remove campo Relacionado
    .replace(/\[\[([^\]]+)\]\]/g, '$1')           // [[link]] → link
    .replace(/^#+\s*/gm, '')                      // remove ## títulos
    .replace(/\n{3,}/g, '\n\n')                   // limpa linhas extras
    .trim();
}

// ─── EMBEDDINGS ───────────────────────────────────────────────────────────────

async function gerarEmbedding(texto) {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`,
      { content: { parts: [{ text: texto.slice(0, 2000) }] } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return r.data.embedding.values;
  } catch (e) {
    return null;
  }
}

// ─── SUPABASE DB ──────────────────────────────────────────────────────────────

async function inserirInsight(titulo, conteudo, origem, tipo, nomeArquivo) {
  const embedding = await gerarEmbedding(`${titulo}\n${conteudo.slice(0, 1500)}`);
  const { data, error } = await supabase
    .from('insights')
    .insert({ titulo, conteudo, origem, tipo, arquivo_obsidian: nomeArquivo, embedding })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function extrairEMontarConvicoes(texto, origem, tipo) {
  const blocos = texto.split(/\n---\n/).filter(b => b.trim());
  const resultados = [];
  for (const bloco of blocos) {
    const tituloMatch = bloco.match(/##\s+(.+)/);
    const titulo = tituloMatch ? tituloMatch[1].trim().slice(0, 80) : origem;
    const nomeArquivo = sanitizar(titulo) + '.md';
    const insight = await inserirInsight(titulo, bloco.trim(), origem, tipo, nomeArquivo);
    resultados.push({ id: insight.id, titulo, nomeArquivo });
  }
  return resultados;
}

// ─── AI APIs ──────────────────────────────────────────────────────────────────

async function chamarGemini(prompt, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 1000 + i * 2000));
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      return res.data.candidates[0].content.parts[0].text;
    } catch (e) {
      if (i === tentativas - 1) throw e;
    }
  }
}

async function chamarClaude(prompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

async function chamarGroq(prompt, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 500 + i * 1000));
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 6000,
          temperature: 0.85
        },
        { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      return res.data.choices[0].message.content;
    } catch (e) {
      if (i === tentativas - 1) throw e;
    }
  }
}

const promptConviccoes = (fileName, texto) => `Você é o assistente de segundo cérebro do Leonam Alves, estrategista de conteúdo baseado em São Luís. Leia o texto abaixo e extraia convicções em português brasileiro.

Cada convicção deve:
- Ter um título direto (máximo 8 palavras)
- Ter 2 a 4 linhas explicando a ideia com clareza
- Indicar a origem
- Ter links para os MOCs relevantes do vault usando o formato [[Nome]]

MOCs disponíveis:
${MOCS}

Formato de saída (markdown):

## [Título da Convicção]
[Explicação em 2-4 linhas]
**Origem:** ${fileName}
**Relacionado:** [[MOC relevante]]

---

Se houver mais de uma convicção, separe com ---

Texto:
${texto.slice(0, 3500)}`;

// ─── NOTA/TEXTO ───────────────────────────────────────────────────────────────
app.post('/api/ingerir/texto', async (req, res) => {
  const { texto, origem, tipo } = req.body;
  if (!texto) return res.status(400).json({ erro: 'Texto vazio' });
  try {
    const resposta = await chamarGemini(promptConviccoes(origem || 'nota', texto));
    const convicoes = await extrairEMontarConvicoes(resposta, origem || 'nota', tipo || 'nota');
    res.json({ ok: true, convicoes });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── PDF COM PROGRESSO SSE ────────────────────────────────────────────────────
app.post('/api/ingerir/pdf/iniciar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  const jobId = `pdf-${Date.now()}`;
  const jobPath = path.join(os.tmpdir(), `leonamos-job-${jobId}.json`);
  fs.writeFileSync(jobPath, JSON.stringify({
    filePath: req.file.path,
    origem: req.body.origem || req.file.originalname.replace('.pdf', ''),
    status: 'pending'
  }));
  res.json({ ok: true, jobId });
});

function detectarCapitulos(texto) {
  const padroes = [
    /^(cap[íi]tulo\s+\d+[^\n]*)/gim,
    /^(chapter\s+\d+[^\n]*)/gim,
    /^(\d+\.\s+[A-ZÁÉÍÓÚÀÃÕÂÊÔÜÇ][^\n]{3,60})\n/gm,
    /^(parte\s+[IVXLC\d]+[^\n]*)/gim,
  ];

  const marcadores = [];
  for (const padrao of padroes) {
    let match;
    while ((match = padrao.exec(texto)) !== null) {
      marcadores.push({ pos: match.index, titulo: match[1].trim() });
    }
  }

  if (marcadores.length < 2) return null;

  marcadores.sort((a, b) => a.pos - b.pos);

  const capitulos = [];
  for (let i = 0; i < marcadores.length; i++) {
    const inicio = marcadores[i].pos;
    const fim = marcadores[i + 1] ? marcadores[i + 1].pos : texto.length;
    const conteudo = texto.slice(inicio, fim).trim();
    if (conteudo.length > 300) {
      capitulos.push({ titulo: marcadores[i].titulo, conteudo });
    }
  }

  return capitulos.length >= 2 ? capitulos : null;
}

app.get('/api/ingerir/pdf/progresso/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const jobPath = path.join(os.tmpdir(), `leonamos-job-${jobId}.json`);
  if (!fs.existsSync(jobPath)) return res.status(404).json({ erro: 'Job não encontrado' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (tipo, dados) => {
    res.write(`data: ${JSON.stringify({ tipo, ...dados })}\n\n`);
  };

  try {
    const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    const { filePath, origem } = job;

    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const textoCompleto = data.text;

    const capitulos = detectarCapitulos(textoCompleto);
    const modoCapitulos = !!capitulos;

    const CHUNK_SIZE = 4000;
    const OVERLAP = 300;
    let chunks = [];

    if (modoCapitulos) {
      chunks = capitulos.map(c => ({ titulo: c.titulo, conteudo: c.conteudo }));
    } else {
      let i = 0;
      while (i < textoCompleto.length) {
        chunks.push({ titulo: null, conteudo: textoCompleto.slice(i, i + CHUNK_SIZE) });
        i += CHUNK_SIZE - OVERLAP;
      }
    }

    send('inicio', { total: chunks.length, origem, modoCapitulos });

    const todosAprendizados = [];
    const notasCapitulos = [];

    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const conteudo = chunk.conteudo.trim();
      const tituloCapitulo = chunk.titulo;

      if (conteudo.length < 150) {
        send('chunk', { atual: c + 1, total: chunks.length, status: 'sem_conteudo' });
        continue;
      }
      await new Promise(r => setTimeout(r, 1200));
      try {
        const resposta = await chamarGemini(
          `Você é o assistente de segundo cérebro do Leonam Alves. Leia este trecho do livro "${origem}"${tituloCapitulo ? ` (${tituloCapitulo})` : ''} e extraia os conceitos, argumentos e aprendizados mais relevantes em português brasileiro. Seja direto e objetivo. Se o trecho não tiver conteúdo relevante (índice, referências, etc), responda apenas "SEM_CONTEUDO".\n\nTrecho (parte ${c + 1} de ${chunks.length}):\n${conteudo.slice(0, 4000)}`
        );

        if (!resposta.includes('SEM_CONTEUDO')) {
          todosAprendizados.push(resposta.trim());

          if (modoCapitulos && tituloCapitulo) {
            notasCapitulos.push({ titulo: tituloCapitulo, conteudo: resposta.trim(), indice: c + 1 });
          }

          send('chunk', { atual: c + 1, total: chunks.length, status: 'ok', preview: (tituloCapitulo || resposta).slice(0, 80) + '...' });
        } else {
          send('chunk', { atual: c + 1, total: chunks.length, status: 'sem_conteudo' });
        }
      } catch (e) {
        send('chunk', { atual: c + 1, total: chunks.length, status: 'erro', erro: e.message });
      }
    }

    send('consolidando', { msg: 'Gerando notas de capítulos, nota de leitura e síntese...' });

    const conteudoConsolidado = todosAprendizados.join('\n\n---\n\n');
    const hoje = new Date().toISOString().slice(0, 10);

    const [notaLeitura, notaSintese, temaDetectado] = await Promise.all([
      chamarGemini(`Você é o assistente de segundo cérebro do Leonam Alves. Com base nos aprendizados extraídos do livro "${origem}", crie uma nota de leitura estruturada seguindo os 3 estágios de Mortimer Adler.\n\nFormato em markdown:\n---\ntipo: livro-leitura\ntítulo: ${origem}\ntema: [um dos: ${TEMAS.join(', ')}]\ndata_captura: ${hoje}\nstatus: processado\n---\n\n# ${origem} — Nota de Leitura\n\n## Estágio I — Estrutural: O que é o livro?\n### Classificação\n### Tese central (uma frase)\n### Partes principais\n### Problemas que o livro responde\n\n## Estágio II — Interpretativo: O que está sendo dito?\n### Termos-chave\n| Termo | Definição do Autor |\n|---|---|\n### Proposições principais\n### Como o autor argumenta\n### O que foi e não foi resolvido\n\n## Estágio III — Crítico: O livro é verdadeiro?\n### Postura geral\n### Pontos sólidos ✓\n### Limitações ✗\n\n## Trechos e passagens marcantes\n\n## Conexões com outras notas\n\nAprendizados:\n${conteudoConsolidado.slice(0, 8000)}`),
      chamarGemini(`Você é o assistente de segundo cérebro do Leonam Alves. Com base nos aprendizados do livro "${origem}", crie uma nota de síntese respondendo as 4 perguntas essenciais de Adler.\n\nFormato:\n---\ntipo: livro-síntese\nfonte: [[03 - Literatura/${sanitizar(origem)}]]\ntema: [um dos: ${TEMAS.join(', ')}]\ndata_captura: ${hoje}\n---\n\n# ${origem} — Síntese\n\n## 1. Sobre o quê é o livro?\n\n## 2. O que está sendo dito, e como?\n\n## 3. O livro é verdadeiro?\n\n## 4. E daí? Como aplicar?\n### No negócio (3–5 aplicações)\n### No dia a dia (3–5 hábitos)\n\n## Citações marcantes\n\n## Conexões com outras notas\n\nAprendizados:\n${conteudoConsolidado.slice(0, 8000)}`),
      chamarGemini(`Com base no conteúdo do livro "${origem}", qual é o tema principal? Responda APENAS com um dos seguintes temas, sem explicação: ${TEMAS.join(', ')}`)
    ]);

    const tema = TEMAS.find(t => temaDetectado.includes(t)) || 'Estratégia';
    const nomeArq = sanitizar(origem);

    const caminhoLeitura = path.join(VAULT, '03 - Literatura', `${nomeArq}.md`);
    const caminhoSintese = path.join(VAULT, '02 - Notas Permanentes', tema, `${nomeArq} - Síntese.md`);
    const caminhoMOC = path.join(VAULT, '01 - MOCs', `MOC - ${tema}.md`);

    salvarNoObsidian(caminhoLeitura, notaLeitura);
    salvarNoObsidian(caminhoSintese, notaSintese);

    if (fs.existsSync(caminhoMOC)) {
      let moc = fs.readFileSync(caminhoMOC, 'utf8');
      if (!moc.includes('## Livros')) moc += '\n## Livros\n';
      if (!moc.includes(nomeArq)) moc = moc.replace('## Livros\n', `## Livros\n- [[${nomeArq} - Síntese]] — ${origem}\n`);
      fs.writeFileSync(caminhoMOC, moc, 'utf8');
    } else {
      salvarNoObsidian(caminhoMOC, `# MOC — ${tema}\n\n## Livros\n- [[${nomeArq} - Síntese]] — ${origem}\n`);
    }

    await inserirInsight(`${origem} — Síntese`, notaSintese, origem, 'livro', `${nomeArq} - Síntese.md`);

    const notasCapitulosSalvas = [];
    if (modoCapitulos && notasCapitulos.length > 0) {
      const hoje2 = new Date().toISOString().slice(0, 10);
      for (const cap of notasCapitulos) {
        try {
          const nomeCapArq = sanitizar(`${nomeArq} - ${cap.titulo}`);
          const conteudoCap = `---\ntipo: livro-capítulo\nlivro: [[03 - Literatura/${nomeArq}]]\ncapítulo: ${cap.titulo}\ntema: ${tema}\ndata_captura: ${hoje2}\n---\n\n# ${cap.titulo}\n\n> Parte de: [[${nomeArq} — Síntese]]\n\n## Aprendizados\n\n${cap.conteudo}\n\n## Conexões\n\n[[MOC - ${tema}]]`;
          const caminhoCap = path.join(VAULT, '03 - Literatura', nomeArq, `${nomeCapArq}.md`);
          salvarNoObsidian(caminhoCap, conteudoCap);
          await inserirInsight(`${cap.titulo}`, conteudoCap, origem, 'livro', `${nomeCapArq}.md`);
          notasCapitulosSalvas.push(cap.titulo);
        } catch (e) {}
      }
    }

    try { fs.unlinkSync(filePath); } catch (e) {}
    try { fs.unlinkSync(jobPath); } catch (e) {}

    send('concluido', {
      tema,
      arquivos: { leitura: caminhoLeitura, sintese: caminhoSintese, moc: caminhoMOC },
      chunks: chunks.length,
      aprendizados: todosAprendizados.length,
      capitulos: notasCapitulosSalvas.length,
      modoCapitulos
    });

  } catch (e) {
    send('erro', { msg: e.message });
  }

  res.end();
});

// ─── YOUTUBE ──────────────────────────────────────────────────────────────────
app.post('/api/ingerir/youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ erro: 'URL vazia' });
  try {
    const { spawn } = require('child_process');
    const tmpDir = os.tmpdir();
    const tmpBase = path.join(tmpDir, `leonam-yt-${Date.now()}`);

    await new Promise((resolve, reject) => {
      const proc = spawn('/opt/homebrew/bin/yt-dlp', [
        '--skip-download', '--write-auto-sub',
        '--sub-langs', 'pt,pt-BR,en', '--sub-format', 'vtt',
        '--cookies-from-browser', 'chrome', '-o', tmpBase, url
      ], { timeout: 120000, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() } });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'yt-dlp falhou')));
    });

    const arquivos = fs.readdirSync(tmpDir).filter(f => f.startsWith(path.basename(tmpBase)) && f.endsWith('.vtt'));
    if (!arquivos.length) return res.status(400).json({ erro: 'Nenhuma legenda encontrada.' });

    const vttContent = fs.readFileSync(path.join(tmpDir, arquivos[0]), 'utf8');
    fs.unlinkSync(path.join(tmpDir, arquivos[0]));

    const textoLinhas = [];
    for (const linha of vttContent.split('\n')) {
      if (linha.startsWith('WEBVTT') || linha.startsWith('Kind:') || linha.startsWith('Language:')) continue;
      if (linha.includes('-->') || linha.trim() === '' || /^\d+$/.test(linha.trim())) continue;
      const limpa = linha.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
      if (limpa && textoLinhas[textoLinhas.length - 1] !== limpa) textoLinhas.push(limpa);
    }
    const transcricao = textoLinhas.join(' ');

    let tituloVideo = url;
    await new Promise((resolve) => {
      const proc = spawn('/opt/homebrew/bin/yt-dlp', ['--get-title', '--cookies-from-browser', 'chrome', url], {
        env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }
      });
      let out = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.on('close', () => { tituloVideo = out.trim() || url; resolve(); });
    });

    const hoje = new Date().toISOString().slice(0, 10);
    const [notaTranscricao, notaInsights, temaDetectado] = await Promise.all([
      chamarGemini(`Crie uma nota de transcrição formatada para o Obsidian do vídeo "${tituloVideo}".\n\nFormato:\n---\ntipo: youtube-transcrição\ntítulo: ${tituloVideo}\nurl: ${url}\ntema: [um dos: ${TEMAS.join(', ')}]\ndata_captura: ${hoje}\n---\n\n# ${tituloVideo}\n\n> **URL:** ${url}\n\n## Descrição\n[resumo em 3-5 linhas]\n\n## Transcrição\n[organizada em parágrafos temáticos]\n\nTranscrição bruta:\n${transcricao.slice(0, 6000)}`),
      chamarGemini(`Você é o assistente de segundo cérebro do Leonam Alves. Crie uma nota de insights do vídeo "${tituloVideo}".\n\nFormato:\n---\ntipo: youtube-insights\nfonte: [[03 - Literatura/YouTube/${sanitizar(tituloVideo)}]]\ntema: [um dos: ${TEMAS.join(', ')}]\ndata_captura: ${hoje}\n---\n\n# ${tituloVideo} — Insights\n\n## Resumo em 3 linhas\n\n## Principais aprendizados\n[5–10 conceitos, 2–4 linhas cada]\n\n## Como aplicar no meu negócio\n[3–5 aplicações práticas]\n\n## Como aplicar no meu dia a dia\n[3–5 hábitos]\n\n## Citações e frases marcantes\n\n## Conexões com outras notas\n\nTranscrição:\n${transcricao.slice(0, 6000)}`),
      chamarGemini(`Com base no título "${tituloVideo}", qual é o tema principal? Responda APENAS com um dos seguintes, sem explicação: ${TEMAS.join(', ')}`)
    ]);

    const tema = TEMAS.find(t => temaDetectado.includes(t)) || 'Estratégia';
    const nomeArq = sanitizar(tituloVideo);
    const caminhoTranscricao = path.join(VAULT, '03 - Literatura', 'YouTube', `${nomeArq}.md`);
    const caminhoInsights = path.join(VAULT, '02 - Notas Permanentes', tema, `${nomeArq} - Insights.md`);
    const caminhoMOC = path.join(VAULT, '01 - MOCs', `MOC - ${tema}.md`);

    salvarNoObsidian(caminhoTranscricao, notaTranscricao);
    salvarNoObsidian(caminhoInsights, notaInsights);

    if (fs.existsSync(caminhoMOC)) {
      let moc = fs.readFileSync(caminhoMOC, 'utf8');
      if (!moc.includes('## YouTube')) moc += '\n## YouTube\n';
      if (!moc.includes(nomeArq)) moc = moc.replace('## YouTube\n', `## YouTube\n- [[${nomeArq} - Insights]] — ${tituloVideo}\n`);
      fs.writeFileSync(caminhoMOC, moc, 'utf8');
    } else {
      salvarNoObsidian(caminhoMOC, `# MOC — ${tema}\n\n## YouTube\n- [[${nomeArq} - Insights]] — ${tituloVideo}\n`);
    }

    await inserirInsight(`${tituloVideo} — Insights`, notaInsights, tituloVideo, 'youtube', `${nomeArq} - Insights.md`);
    res.json({ ok: true, titulo: tituloVideo, tema, arquivos: { transcricao: caminhoTranscricao, insights: caminhoInsights, moc: caminhoMOC } });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── DOCX ─────────────────────────────────────────────────────────────────────
app.post('/api/ingerir/docx', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  try {
    const mammoth = require('mammoth');
    const resultado = await mammoth.extractRawText({ path: req.file.path });
    const texto = resultado.value.trim();
    if (!texto || texto.length < 100) return res.status(400).json({ erro: 'Arquivo vazio ou sem conteúdo legível' });

    const origem = req.body.origem || req.file.originalname.replace(/\.docx$/i, '');
    const resposta = await chamarGemini(promptConviccoes(origem, texto));
    const convicoes = await extrairEMontarConvicoes(resposta, origem, 'nota');

    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.json({ ok: true, origem, convicoes });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── CRIAÇÃO DE CONTEÚDO ──────────────────────────────────────────────────────
async function buscarNotasVault(tema) {
  // Busca semântica via Supabase (primária)
  try {
    const embedding = await gerarEmbedding(tema);
    if (embedding) {
      const { data } = await supabase.rpc('match_insights', {
        query_embedding: embedding,
        match_count: 8
      });
      if (data && data.length > 0) {
        return data.map(n => ({
          arquivo: n.arquivo_obsidian || 'nota',
          conteudo: limparNota(n.conteudo).slice(0, 1200)
        }));
      }
    }
  } catch (e) {}

  // Fallback: busca local por keyword quando vault disponível
  if (!fs.existsSync(VAULT)) return [];

  const termos = tema.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const pastas = [
    path.join(VAULT, '02 - Notas Permanentes'),
    path.join(VAULT, '03 - Literatura'),
    path.join(VAULT, '01 - MOCs'),
  ];

  const todasNotas = [];
  for (const pasta of pastas) {
    if (!fs.existsSync(pasta)) continue;
    const arquivos = fs.readdirSync(pasta, { recursive: true }).filter(f => String(f).endsWith('.md'));
    for (const arq of arquivos) {
      try {
        const caminho = path.join(pasta, String(arq));
        if (!fs.statSync(caminho).isFile()) continue;
        const conteudo = fs.readFileSync(caminho, 'utf8');
        const hits = termos.filter(t => conteudo.toLowerCase().includes(t)).length;
        if (hits > 0) todasNotas.push({ arquivo: String(arq), conteudo, hits });
      } catch (e) {}
    }
  }

  todasNotas.sort((a, b) => b.hits - a.hits);
  return todasNotas.slice(0, 15).map(n => ({
    arquivo: n.arquivo,
    conteudo: n.conteudo.slice(0, 3000)
  }));
}

app.post('/api/conteudo/gerar', upload.any(), async (req, res) => {
  const tema = req.body.tema;
  const tipo = req.body.tipo;
  const angulo = req.body.angulo;
  const briefing = req.body.briefing || '';
  const urls = req.body.urls ? JSON.parse(req.body.urls) : [];
  if (!tema) return res.status(400).json({ erro: 'Tema obrigatório' });

  try {
    const notas = await buscarNotasVault(tema);
    const contextoVault = notas.length > 0
      ? `\n\nNOTAS DO MEU VAULT SOBRE ESSE TEMA (use para extrair minha opinião e conhecimento real):\n${notas.map(n => `--- ${n.arquivo} ---\n${n.conteudo}`).join('\n\n')}`
      : '\n\n(Nenhuma nota encontrada no vault sobre esse tema — use apenas seu conhecimento geral sobre estratégia e negócios para criativos.)';

    // ── FONTES PRIMÁRIAS (briefing + links + PDFs fornecidos pelo Leonam) ─────────
    let fontePrincipal = '';
    if (briefing) fontePrincipal += `BRIEFING DO LEONAM:\n${briefing}\n\n`;

    for (const url of urls.slice(0, 5)) {
      try {
        const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
        const texto = r.data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, 2000);
        fontePrincipal += `LINK DE REFERÊNCIA (${url}):\n${texto}\n\n`;
      } catch (e) { fontePrincipal += `LINK (${url}): não foi possível acessar\n\n`; }
    }

    const pdfFiles = (req.files || []).filter(f => f.fieldname.startsWith('pdf_'));
    for (const pdfFile of pdfFiles) {
      try {
        const pdfParse = require('pdf-parse');
        const buffer = fs.readFileSync(pdfFile.path);
        const data = await pdfParse(buffer);
        fontePrincipal += `DOCUMENTO "${pdfFile.originalname}":\n${data.text.slice(0, 3000)}\n\n`;
        try { fs.unlinkSync(pdfFile.path); } catch (e) {}
      } catch (e) {}
    }

    const temFontePrincipal = fontePrincipal.trim().length > 0;

    let prompt;

    const estiloBase = `
IDENTIDADE DO AUTOR:
Leonam Alves é estrategista de conteúdo baseado em São Luís, Maranhão. Ajuda criativos, designers e freelancers a entenderem a lógica de negócios para construírem carreiras e negócios sustentáveis. Tom: direto, realista, pragmático. Sem metáforas forçadas, sem papo motivacional vazio.

ESTILO DE ESCRITA (obrigatório replicar):
- Abre SEMPRE com uma situação concreta narrada na 3ª pessoa: um cliente que ligou, uma conversa real, um caso que aconteceu. PROIBIDO abrir com pergunta ao leitor. PROIBIDO: "Você já se sentiu...", "Você já se perguntou...", "Imagine que...", "E se você...". PROIBIDO como primeira frase qualquer coisa que comece com "Você".
- Parágrafos curtos: 1 a 3 linhas. Nunca blocos pesados.
- Frases de impacto em linha própria: "Isso é exatamente o oposto da verdade.", "Gargalos não são promovidos.", "Atenção é barata. Confiança é cara."
- Usa → para marcar conclusões ou viradas de lógica
- Bold (**) em frases que o leitor vai querer sublinhar
- Subtítulos emergem do argumento específico — nunca genéricos. PROIBIDO usar: "A Importância de X", "O Framework para X", "O Que Você Pode Fazer Hoje", "Por que X é essencial"
- Tom pessoal direto, mas não fabricar histórias
- PALAVRAS BANIDAS: fundamental, essencial, é importante, você já se perguntou, imagine que, lembre-se de que, proposta de valor única, audiência comprometida, foco claro, jornada, ecossistema, sinergias, impacto positivo
- ANALOGIAS: máximo UMA por peça. Evitar: caçador/fazendeiro, terreno alugado, construir casa na areia, plantar sementes, maratona vs sprint
- Assina como "Leo" ou "Leonam" no final`;

    const secaoBriefing = temFontePrincipal ? `
════════════════════════════════
MATÉRIA-PRIMA OBRIGATÓRIA (briefing, links e docs fornecidos pelo Leonam)
O conteúdo abaixo É A BASE do texto. Use os argumentos, dados, referências e ideias daqui.
Não ignore. Não substitua por genérico.
════════════════════════════════
${fontePrincipal.slice(0, 6000)}
` : '';

    const secaoVault = `
════════════════════════════════
NOTAS DO VAULT (contexto complementar — use para reforçar com voz e convicções do Leonam)
════════════════════════════════
${contextoVault.slice(0, 3000)}`;

    if (tipo === 'carrossel') {
      prompt = `Você é o ghostwriter do Leonam Alves. Escreva um carrossel de Instagram no estilo dele.

${estiloBase}
${secaoBriefing}
════════════════════════════════
PADRÕES EDITORIAIS DOS CARROSSÉIS DO LEONAM
════════════════════════════════
ESTRUTURA NARRATIVA:
1. GANCHO com nome real e situação concreta (ex: "A Cimed ofereceu um contrato milionário para o Toguro.")
2. Valida parcialmente o argumento oposto antes de destruí-lo
3. Identifica a falha lógica central com precisão — não é opinião, é análise
4. Paradoxo que inverte a conclusão óbvia
5. Dados específicos contextualizados (números reais, nomes reais) — USE os dados da matéria-prima acima
6. Slides de 3-6 linhas quando o argumento precisa — não fragmentado
7. Penúltimo slide conecta a análise ao público (designers, criativos, freelancers, empreendedores)
8. CTA com mecanismo: "Comente MARCA", "Salva esse post" — nunca "Me siga"

ESTRUTURA VISUAL (cada slide tem função visual específica — escreva o texto respeitando isso):
- SLIDE 1 (GANCHO): Headline curta e impactante em caixa alta + 1 subtítulo explicativo + CTA "→ Deslize para entender a análise."
- SLIDES DE CONCEITO/ANÁLISE: Começam com etiqueta entre colchetes [ FUNÇÃO DO SLIDE ] + título bold + texto corrido. Ex de etiquetas: [ O QUE ESTÁ EM JOGO ], [ A CIÊNCIA DA DECISÃO ], [ O FRAMEWORK QUE RESOLVE O IMPASSE ], [ COMO O FUNIL FUNCIONA NA PRÁTICA ]
- SLIDES DE DADO/PROVA: Destaque de número ou citação, depois análise curta
- SLIDE DE APLICAÇÃO: Etiqueta [ COMO ISSO SE APLICA À SUA CARREIRA ] + conecta ao público-alvo (criativos, designers, freelancers)
- SLIDE FINAL (CTA): Chamada para ação direta

Tema: "${tema}"
Ângulo: ${angulo || 'contraintuitivo — questione uma crença que o mercado aceita como verdade'}

Decida antes de escrever:
- Qual caso real ou nome específico (da matéria-prima acima) usar como âncora?
- Qual é a crença errada a destruir?
- Qual é a virada lógica inesperada?
- Quantos slides o argumento precisa? (mínimo 8, máximo 15)

FORMATO DE SAÍDA OBRIGATÓRIO:
**SLIDE 1 — GANCHO**
[texto — headline + subtítulo + CTA deslize]

**SLIDE 2 — [FUNÇÃO]**
[texto — inclua a etiqueta [ ] no início se for slide de conceito/análise]

[continue. Funções possíveis: CONTEXTO, CONCEITO, AGITAÇÃO, DESCONSTRUÇÃO, DADO, PARADOXO, VIRADA, FRAMEWORK, FUNIL, APLICAÇÃO, REVERSÃO DE STATUS, CTA]

LEGENDA SUGERIDA:
[legenda]
${secaoVault}
`;

    } else {
      prompt = `Você é o ghostwriter do Leonam Alves. Sua única tarefa é replicar o estilo exato dele.

${estiloBase}
${secaoBriefing}
════════════════════════════════
EXEMPLO REAL DE NEWSLETTER DO LEONAM
(Estude o TOM e a ABERTURA. NÃO replique os subtítulos — crie subtítulos originais que emergem do seu argumento.)
════════════════════════════════

☕ Mentoria matinal • 5 min de leitura

Bom dia!

Um cliente me ligou na semana passada com uma pergunta direta:

"Leonam, a gente mudou o posicionamento da agência. Faz sentido fazer um post anunciando a nova fase?"

Eu perguntei: quando você muda de ideia sobre algo na sua vida pessoal, você manda comunicado para os seus amigos?

Ele ficou quieto por uns três segundos. Depois disse: "entendi o ponto."

Esse é o erro que a maioria das marcas comete quando decide se reposicionar.

## Reposicionamento não é lançamento

Quando uma marca decide mudar de direção, o instinto é comunicar. "Nova fase." "Agora somos diferentes." "Mudamos."

Esse anúncio cria um problema imediato: você promete uma transformação que precisa existir em todos os pontos de contato — produto, atendimento, comunicação, preço — e raramente está.

O mercado vai comparar o que você prometeu com o que ele experiencia. E a conta quase sempre não fecha.

**Reposicionamento de marca é silencioso — nunca declarado como ruptura.**

A Cimed não publicou um post "agora somos jovens e inovadores." Eles simplesmente passaram a ser. Colabs com a Fini, identidade visual reformulada, comunicação com um tom diferente. O mercado percebeu. Ninguém precisou ser avisado.

## O sinal de que está funcionando

Você sabe que seu reposicionamento deu certo quando o mercado começa a te chamar pelo novo ângulo — sem que você tenha pedido.

Quando os clientes que chegam já chegam esperando o que você decidiu entregar. Quando as indicações batem com o posicionamento que você construiu nos últimos meses em silêncio.

Isso não acontece em semanas. Acontece em ciclos de 6 a 12 meses de comportamento consistente.

→ **Quem percebe é o mercado. Quem anuncia cria expectativa que a execução raramente sustenta.**

## Faça isso hoje

Pega os últimos 3 meses de conteúdo, atendimento e proposta que você entregou.

Lê tudo como se fosse um estranho que nunca te viu.

Pergunta: essa sequência de comportamento aponta para alguma direção clara? Ou ela poderia pertencer a qualquer agência genérica do mercado?

Se a resposta for "qualquer um poderia ter feito isso", o problema não é o posicionamento que você declarou. É o que você está, de fato, fazendo.

Um abraço,
Leo

════════════════════════════════
AGORA ESCREVA A NEWSLETTER
════════════════════════════════

Tema: "${tema}"
Ângulo: ${angulo || 'estratégico'}

REGRAS ABSOLUTAS:
1. ABERTURA: começa com diálogo real ou situação na 3ª pessoa. A primeira palavra NÃO pode ser "Você". PROIBIDO abrir com pergunta ao leitor.
2. EXATAMENTE 3 seções com subtítulo — nem 2, nem 4, nem 5. Três.
3. SUBTÍTULOS: crie títulos que emergem do argumento específico do briefing. PROIBIDO títulos genéricos como "A Importância de X", "O Framework para X", "O Que Você Pode Fazer Hoje".
4. EXERCÍCIO FINAL (3ª seção): ação concreta com verbo no imperativo. PROIBIDO "pergunte a si mesmo", "reflita sobre", "pense em".
5. 600-800 palavras.
6. Se há matéria-prima acima: o argumento central DEVE vir de lá. Não substitua por genérico.
${secaoVault}`;
    }

    // Exemplos anteriores aprovados para calibrar o estilo
    let exemplosAnteriores = '';
    try {
      const { data: hist } = await supabase
        .from('historico_conteudo')
        .select('tema, conteudo')
        .eq('tipo', tipo)
        .order('criado_em', { ascending: false })
        .limit(2);
      if (hist && hist.length > 0) {
        const label = tipo === 'carrossel' ? 'carrosséis aprovados' : 'artigos aprovados';
        exemplosAnteriores = `\n════════════════════════════════
EXEMPLOS REAIS DO LEONAM (últimos ${label} — calibre formato, tamanho e voz com base neles)
════════════════════════════════\n` + hist.map((h, idx) =>
          `EXEMPLO ${idx + 1} — tema: "${h.tema}"\n${h.conteudo.slice(0, 2500)}`
        ).join('\n\n---\n\n');
      }
    } catch (_) {}

    const promptFinal = prompt + exemplosAnteriores;
    const conteudo = await chamarClaude(promptFinal);
    const notasUsadas = notas.map(n => n.arquivo);

    // Salva no histórico (silencioso em caso de falha)
    try {
      await supabase.from('historico_conteudo').insert({ tema, tipo, angulo: angulo || '', conteudo });
    } catch (_) {}

    res.json({ ok: true, conteudo, notasUsadas, tema, tipo });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/conteudo/historico', async (req, res) => {
  const { tipo, limit = 30 } = req.query;
  try {
    let query = supabase
      .from('historico_conteudo')
      .select('id, tema, tipo, angulo, criado_em, conteudo')
      .order('criado_em', { ascending: false })
      .limit(parseInt(limit));
    if (tipo && tipo !== 'todos') query = query.eq('tipo', tipo);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/conteudo/historico/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('historico_conteudo').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/conteudo/exportar', (req, res) => {
  const { conteudo, tema, tipo } = req.body;
  if (!conteudo) return res.status(400).json({ erro: 'Conteúdo vazio' });
  try {
    const pasta = tipo === 'carrossel' ? 'Carrosséis' : 'Substack';
    const nomeArq = sanitizar(tema || 'conteudo') + '.md';
    const caminho = path.join(VAULT, '04 - Projetos', 'Escrita sem Algoritmo', pasta, nomeArq);
    salvarNoObsidian(caminho, conteudo);
    res.json({ ok: true, caminho });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── BIBLIOTECA ───────────────────────────────────────────────────────────────
app.get('/api/insights', async (req, res) => {
  const { tipo, busca } = req.query;
  try {
    let query = supabase.from('insights').select('id, titulo, conteudo, origem, tipo, arquivo_obsidian, criado_em').order('criado_em', { ascending: false });
    if (tipo && tipo !== 'todos') query = query.eq('tipo', tipo);
    if (busca) query = query.or(`titulo.ilike.%${busca}%,conteudo.ilike.%${busca}%`);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Busca semântica — usada pelo plugin do Obsidian e pelo frontend
app.get('/api/insights/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ erro: 'Parâmetro q obrigatório' });
  try {
    const embedding = await gerarEmbedding(q);
    if (!embedding) return res.status(500).json({ erro: 'Falha ao gerar embedding' });
    const { data, error } = await supabase.rpc('match_insights', {
      query_embedding: embedding,
      match_count: parseInt(limit)
    });
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/exportar/:id', async (req, res) => {
  try {
    const { data: insight, error } = await supabase.from('insights').select('*').eq('id', req.params.id).single();
    if (error || !insight) return res.status(404).json({ erro: 'Não encontrado' });
    const caminho = path.join(VAULT, '02 - Notas Permanentes', 'Convicções do Leonam', insight.arquivo_obsidian);
    salvarNoObsidian(caminho, insight.conteudo);
    res.json({ ok: true, caminho });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/exportar-todos', async (req, res) => {
  try {
    const { data: insights } = await supabase.from('insights').select('*');
    let exportados = 0;
    for (const insight of insights || []) {
      try {
        const caminho = path.join(VAULT, '02 - Notas Permanentes', 'Convicções do Leonam', insight.arquivo_obsidian);
        salvarNoObsidian(caminho, insight.conteudo);
        exportados++;
      } catch (e) {}
    }
    res.json({ ok: true, exportados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/insights/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('insights').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('insights').select('tipo');
    if (error) throw new Error(error.message);
    const porTipo = (data || []).reduce((acc, i) => { acc[i.tipo] = (acc[i.tipo] || 0) + 1; return acc; }, {});
    res.json({ total: (data || []).length, porTipo });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── PLUGIN DO OBSIDIAN ───────────────────────────────────────────────────────
// POST /api/plugin/indexar — recebe uma nota do Obsidian e indexa no Supabase
app.post('/api/plugin/indexar', async (req, res) => {
  const { titulo, conteudo, origem, tipo, arquivo_obsidian } = req.body;
  if (!conteudo) return res.status(400).json({ erro: 'Conteúdo vazio' });
  try {
    // Verifica se já existe pelo caminho do arquivo
    if (arquivo_obsidian) {
      const { data: existente } = await supabase
        .from('insights')
        .select('id')
        .eq('arquivo_obsidian', arquivo_obsidian)
        .single();

      if (existente) {
        // Atualiza o existente
        const embedding = await gerarEmbedding(`${titulo || ''}\n${conteudo.slice(0, 1500)}`);
        const { data, error } = await supabase
          .from('insights')
          .update({ titulo, conteudo, origem, tipo, embedding })
          .eq('id', existente.id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        return res.json({ ok: true, acao: 'atualizado', insight: data });
      }
    }

    const insight = await inserirInsight(
      titulo || arquivo_obsidian || 'nota',
      conteudo,
      origem || 'obsidian',
      tipo || 'nota',
      arquivo_obsidian || sanitizar(titulo || 'nota') + '.md'
    );
    res.json({ ok: true, acao: 'criado', insight });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── MIGRAÇÃO DO JSON ANTIGO ──────────────────────────────────────────────────
app.post('/api/migrar', async (req, res) => {
  const DB_PATH = path.join(os.homedir(), 'leonam-os-db.json');
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ erro: 'leonam-os-db.json não encontrado' });
  try {
    const { insights } = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    let migrados = 0;
    let erros = 0;
    for (const ins of insights) {
      try {
        const embedding = await gerarEmbedding(`${ins.titulo}\n${(ins.conteudo || '').slice(0, 1500)}`);
        await supabase.from('insights').insert({
          titulo: ins.titulo,
          conteudo: ins.conteudo,
          origem: ins.origem,
          tipo: ins.tipo,
          arquivo_obsidian: ins.arquivo_obsidian,
          criado_em: ins.criado_em,
          embedding
        });
        migrados++;
      } catch (e) { erros++; }
    }
    res.json({ ok: true, migrados, erros, total: insights.length });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── TENDÊNCIAS & SUGESTÃO DE TEMAS ──────────────────────────────────────────

// Pesquisa aprofundada de pauta: cobertura de mídia, PAA, relevância editorial
app.get('/api/pesquisa-tema', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ erro: 'Parâmetro q obrigatório' });

  const resultado = { tema: q };

  // 1. Google News — contagem de portais e artigos recentes
  try {
    const newsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
    const newsR = await axios.get(newsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const items = newsR.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const artigos = items.slice(0, 12).map(item => {
      const titulo = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
      const fonte = (item.match(/<source[^>]*url="[^"]*"[^>]*>(.*?)<\/source>/))?.[1]?.trim()
        || (item.match(/<source>(.*?)<\/source>/))?.[1]?.trim()
        || titulo?.split(' - ').pop()?.trim() || 'Portal';
      const dataStr = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
      return { titulo, fonte, dataStr };
    }).filter(a => a.titulo);
    resultado.artigos = artigos;
    resultado.totalPortais = artigos.length;
    resultado.fontes = [...new Set(artigos.map(a => a.fonte).filter(Boolean))].slice(0, 8);
  } catch (e) {
    resultado.artigos = [];
    resultado.totalPortais = 0;
    resultado.fontes = [];
  }

  // 2. Google Autocomplete — perguntas que as pessoas fazem (proxy para PAA)
  const perguntas = new Set();
  const prefixos = ['como ', 'por que ', 'o que é ', 'qual ', 'quando ', 'quem '];
  for (const prefix of prefixos) {
    try {
      const autoUrl = `https://suggestqueries.google.com/complete/search?q=${encodeURIComponent(prefix + q)}&hl=pt-BR&gl=BR&output=json&client=firefox`;
      const autoR = await axios.get(autoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      let data = autoR.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) {}
      }
      if (Array.isArray(data) && Array.isArray(data[1])) {
        data[1].slice(0, 4).forEach(s => perguntas.add(s));
      }
    } catch (e) {}
  }
  // Termos relacionados genéricos também
  try {
    const autoUrl = `https://suggestqueries.google.com/complete/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&output=json&client=firefox`;
    const autoR = await axios.get(autoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
    let data = autoR.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
    if (Array.isArray(data) && Array.isArray(data[1])) {
      data[1].slice(0, 5).forEach(s => perguntas.add(s));
    }
  } catch (e) {}

  resultado.perguntas = [...perguntas].slice(0, 10);

  // 3. Claude — análise editorial completa
  const prompt = `Você é o diretor editorial e estrategista de SEO do Leonam Alves.

TEMA PESQUISADO: "${q}"

LINHA EDITORIAL DO LEONAM: marketing de posicionamento, marca pessoal para criativos, precificação, copywriting, IA aplicada, gestão de freelancers e agências no Brasil.

COBERTURA DA MÍDIA: ${resultado.totalPortais} artigos encontrados nos últimos dias
PORTAIS COBRINDO: ${resultado.fontes.join(', ') || 'dados não disponíveis'}
TÍTULOS RECENTES:
${resultado.artigos.slice(0, 6).map(a => `- ${a.titulo} (${a.fonte})`).join('\n') || 'Sem artigos recentes'}

PERGUNTAS QUE AS PESSOAS BUSCAM SOBRE ESSE TEMA:
${resultado.perguntas.length > 0 ? resultado.perguntas.map(p => `- ${p}`).join('\n') : 'Dados não disponíveis'}

Entregue a análise no formato abaixo. Sem introdução, sem "claro que", sem "certamente".

POR QUE FAZ SENTIDO PARA O LEONAM:
[2-3 frases diretas — sobreposição específica com a audiência de criativos e freelancers. Cite o contexto do mercado brasileiro.]

VOLUME E MOMENTO:
[Avalie com base na cobertura de mídia: esse tema está aquecendo, no pico ou saindo de moda? Por quê? Seja honesto se não há dados suficientes.]

PERGUNTA-CHAVE PARA INDEXAR NO GOOGLE:
[Das perguntas acima, qual o Leonam deveria responder explicitamente no conteúdo para ter chance de aparecer no "People Also Ask"? Por quê essa especificamente?]

ÂNGULO CONTRAINTUITIVO:
[Uma frase — perspectiva que contradiz o que a maioria dos portais está cobrindo ou o senso comum do mercado criativo]

GANCHO DE ABERTURA:
[Primeira linha do conteúdo — situação concreta na 3ª pessoa, nunca começa com "Você"]

TIPO RECOMENDADO: newsletter ou carrossel — e por quê em 1 frase`;

  try {
    resultado.analise = await chamarClaude(prompt);
  } catch (e) {
    resultado.analise = 'Erro ao gerar análise: ' + e.message;
  }

  res.json({ ok: true, ...resultado });
});

app.get('/api/tendencias', async (req, res) => {
  const buscas = [
    'branding+marca+pessoal+creator',
    'marketing+digital+criativo+freelancer',
    'inteligência+artificial+criadores+conteúdo',
    'design+negócios+agência',
    'empreendedorismo+posicionamento+brasil'
  ];

  const noticias = [];
  for (const termo of buscas) {
    try {
      const url = `https://news.google.com/rss/search?q=${termo}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
      const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      const items = r.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items.slice(0, 4)) {
        const titulo = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
        const link = item.match(/<link\/>(.*?)<\/item>/)?.[1]?.trim() || item.match(/<link>(.*?)<\/link>/)?.[1]?.trim();
        const data = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
        if (titulo && titulo.length > 10) noticias.push({ titulo, link, data, categoria: termo.split('+')[0] });
      }
    } catch (e) {}
  }

  // Remove duplicatas por título similar
  const unicos = noticias.filter((n, i, arr) => arr.findIndex(x => x.titulo.slice(0, 30) === n.titulo.slice(0, 30)) === i);

  if (unicos.length === 0) return res.json({ ok: true, noticias: [], sugestoes: 'Sem tendências disponíveis no momento.' });

  // Claude filtra e sugere ângulos no estilo do Leonam
  const prompt = `Você é o assistente editorial do Leonam Alves — estrategista de conteúdo para criativos, designers e freelancers no Brasil.

Linha editorial: marketing de posicionamento, marca pessoal, precificação, gestão de negócios criativos, IA aplicada, copywriting.

Pautas quentes do momento:
${unicos.slice(0, 20).map((n, i) => `${i + 1}. ${n.titulo}`).join('\n')}

Selecione as 6 pautas mais relevantes para a linha editorial do Leonam.
Para cada uma, entregue:

PAUTA: [título limpo, sem nome de veículo]
TIPO: newsletter ou carrossel
ÂNGULO: [uma frase — perspectiva contraintuitiva que o Leonam tomaria. Direto, sem verbo "Descubra" ou "Aprenda"]
GANCHO: [primeira linha do conteúdo — começa com situação concreta, nunca com pergunta ao leitor]

Sem explicações. Só o formato acima, 6 vezes.`;

  try {
    const sugestoes = await chamarClaude(prompt);
    res.json({ ok: true, noticias: unicos.slice(0, 20), sugestoes });
  } catch (e) {
    res.json({ ok: true, noticias: unicos, sugestoes: 'Erro ao gerar sugestões.' });
  }
});

app.post('/api/sugestao-temas', async (req, res) => {
  const { contexto } = req.body;
  try {
    // Busca temas já cobertos no vault para não repetir
    const { data: recentes } = await supabase
      .from('insights')
      .select('titulo, tipo')
      .order('criado_em', { ascending: false })
      .limit(30);

    // Busca métricas do Substack para informar o que performa (opcional — ignora erro se tabela não existir)
    let metricas = null;
    try {
      const { data: m } = await supabase
        .from('substack_posts')
        .select('titulo, taxa_abertura, taxa_clique')
        .order('taxa_abertura', { ascending: false })
        .limit(10);
      metricas = m;
    } catch (e) {}

    const historicoVault = (recentes || []).map(n => `- ${n.titulo}`).join('\n');
    const topPerformers = metricas && metricas.length > 0
      ? `\nTEMAS QUE MAIS ABRIRAM NO SUBSTACK:\n${metricas.map(m => `- "${m.titulo}" (${m.taxa_abertura}% abertura)`).join('\n')}`
      : '';
    const ctxExtra = contexto ? `\nCONTEXTO ADICIONAL: ${contexto}` : '';

    const prompt = `Você é o diretor editorial do Leonam Alves.

LINHA EDITORIAL: marketing de posicionamento, marca pessoal para criativos, precificação, copywriting, IA aplicada a negócios criativos, gestão de freelancers e agências pequenas.

TEMAS RECENTES NO VAULT (evitar repetir):
${historicoVault || 'Nenhum disponível'}
${topPerformers}${ctxExtra}

Gere 8 sugestões de temas originais. Para cada um:

TEMA: [título direto — não genérico, com ângulo específico]
TIPO: newsletter ou carrossel
ÂNGULO: [perspectiva contraintuitiva — 1 frase]
POR QUÊ AGORA: [1 frase — relevância para o momento]

Priorize temas que:
- Contradizem o senso comum do mercado criativo
- Têm uma virada lógica inesperada
- Conectam criatividade com negócios e dinheiro

Sem introdução. Só o formato, 8 vezes.`;

    const sugestoes = await chamarClaude(prompt);
    res.json({ ok: true, sugestoes });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── SUBSTACK DATA ────────────────────────────────────────────────────────────

app.post('/api/substack/importar', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Arquivo CSV não enviado' });
  try {
    const texto = fs.readFileSync(req.file.path, 'utf8');
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    const linhas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (linhas.length < 2) return res.status(400).json({ erro: 'CSV vazio ou inválido' });

    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (const char of line) {
        if (char === '"') { inQuotes = !inQuotes; continue; }
        if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += char;
      }
      result.push(current.trim());
      return result;
    }

    const headers = parseCSVLine(linhas[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
    const posts = [];

    for (let i = 1; i < linhas.length; i++) {
      const cols = parseCSVLine(linhas[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });

      const titulo = row.title || row.titulo || row.subject || row.email_subject || row.post_title || '';
      if (!titulo) continue;

      // open_rate do Substack vem como decimal (0.45 = 45%) ou percentual (45)
      const rawAbertura = parseFloat(row.open_rate || row.taxa_abertura || 0);
      const rawClique   = parseFloat(row.click_rate || row.taxa_clique || 0);
      const taxaAbertura = rawAbertura <= 1 ? rawAbertura * 100 : rawAbertura;
      const taxaClique   = rawClique <= 1   ? rawClique * 100   : rawClique;

      posts.push({
        titulo,
        url:          row.web_url || row.url || row.post_url || '',
        publicado_em: row.published_at || row.date || row.publish_date || null,
        aberturas:    parseInt(row.opens || row.unique_opens || 0) || 0,
        cliques:      parseInt(row.clicks || row.unique_clicks || 0) || 0,
        taxa_abertura: isNaN(taxaAbertura) ? 0 : parseFloat(Math.min(taxaAbertura, 100).toFixed(2)),
        taxa_clique:   isNaN(taxaClique)   ? 0 : parseFloat(Math.min(taxaClique, 100).toFixed(2)),
        visualizacoes: parseInt(row.views || row.email_sends || 0) || 0,
      });
    }

    if (posts.length === 0) {
      return res.status(400).json({
        erro: 'Nenhum post identificado no CSV',
        colunas_detectadas: headers,
        dica: 'Exporte via Substack → Dashboard → Settings → Exports → Posts'
      });
    }

    // Batch insert — deletar existentes e reinserir (mais confiável que upsert com schema cache)
    const { error: delErr } = await supabase.from('substack_posts').delete().neq('id', 0);
    if (delErr && delErr.message.includes('schema cache')) {
      return res.status(500).json({
        erro: 'Schema cache desatualizado',
        dica: 'Vá em Supabase → Settings → API → clique em "Reload schema" e tente novamente'
      });
    }

    const { error: insErr } = await supabase.from('substack_posts').insert(posts);
    if (insErr) {
      return res.status(500).json({
        erro: insErr.message,
        posts_detectados: posts.length,
        colunas_detectadas: headers
      });
    }

    res.json({ ok: true, importados: posts.length, total: posts.length, colunas: headers });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/substack/metricas', async (req, res) => {
  try {
    const { data: posts, error } = await supabase
      .from('substack_posts')
      .select('*')
      .order('taxa_abertura', { ascending: false });

    // Tabela ainda não existe ou sem dados — retorna vazio sem travar
    if (error) return res.json({ ok: true, posts: [], insights: null, aviso: 'Tabela ainda sendo configurada. Recarregue o schema cache no Supabase → Settings → API.' });
    if (!posts || posts.length === 0) return res.json({ ok: true, posts: [], insights: null });

    const melhores = posts.slice(0, 5);
    const piores = [...posts].sort((a, b) => a.taxa_abertura - b.taxa_abertura).slice(0, 3);
    const mediaAbertura = (posts.reduce((s, p) => s + (p.taxa_abertura || 0), 0) / posts.length).toFixed(1);

    const prompt = `Você é o analista de dados editorial do Leonam Alves.

DADOS DO SUBSTACK (${posts.length} newsletters analisadas):
Média de abertura: ${mediaAbertura}%

TOP 5 — MAIOR TAXA DE ABERTURA:
${melhores.map(p => `- "${p.titulo}" → ${p.taxa_abertura}% abertura / ${p.taxa_clique}% clique`).join('\n')}

PIORES 3 — MENOR TAXA DE ABERTURA:
${piores.map(p => `- "${p.titulo}" → ${p.taxa_abertura}% abertura`).join('\n')}

Entregue uma análise editorial direta:
1. O que os títulos/temas com maior abertura têm em comum? (padrão de ângulo, promessa, formato)
2. O que os piores têm em comum? (onde perde a atenção do leitor antes de abrir)
3. Três sugestões de temas baseadas no padrão de sucesso — com título já elaborado

Máximo 250 palavras. Sem papo de coach. Direto ao ponto.`;

    const insights = await chamarClaude(prompt);
    res.json({ ok: true, posts, insights, mediaAbertura });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── GERAÇÃO DE IMAGEM PARA CARROSSEL ─────────────────────────────────────────
// Ordem de tentativas: Imagen 3 Fast → Imagen 3 Standard → Gemini Flash → Pollinations

async function tentarImagen(model, promptFull) {
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${GEMINI_KEY}`,
    { instances: [{ prompt: promptFull }], parameters: { sampleCount: 1, aspectRatio: '4:5' } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 35000 }
  );
  const b64 = r.data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('sem imagem na resposta');
  return b64;
}

app.post('/api/imagem/gerar', async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) return res.status(400).json({ erro: 'prompt obrigatório' });

  // Prompt otimizado para fundos de carrossel Instagram
  const promptFull = `${prompt}, cinematic dramatic lighting, dark moody atmosphere, professional photography, Instagram carousel background, vertical format, high resolution, photorealistic, no text, no watermark`;

  // 1. Nano Banana 2 — Pollinations Turbo (FLUX acelerado, gratuito, confiável)
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const polModel = model || 'turbo';
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptFull)}?width=1080&height=1350&nologo=true&seed=${seed}&model=${polModel}&enhance=true`;
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 55000 });
    if (r.status === 200 && r.data.byteLength > 5000) {
      const b64 = Buffer.from(r.data).toString('base64');
      return res.json({ ok: true, imagem: `data:${r.headers['content-type'] || 'image/jpeg'};base64,${b64}`, fonte: 'nano-banana-2' });
    }
  } catch (e) {
    console.log('Nano Banana 2 (Pollinations turbo) falhou:', e.message);
  }

  // 2. Pollinations flux-realism (fallback de qualidade)
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptFull)}?width=1080&height=1350&nologo=true&seed=${seed}&model=flux-realism`;
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 55000 });
    if (r.status === 200 && r.data.byteLength > 5000) {
      const b64 = Buffer.from(r.data).toString('base64');
      return res.json({ ok: true, imagem: `data:${r.headers['content-type'] || 'image/jpeg'};base64,${b64}`, fonte: 'pollinations-realism' });
    }
  } catch (e) {
    console.log('Pollinations flux-realism falhou:', e.message);
  }

  // 3. Gemini 2.0 Flash image generation
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{ parts: [{ text: promptFull }] }],
        generationConfig: { responseModalities: ['IMAGE'] }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const parts = r.data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    if (imgPart) {
      return res.json({ ok: true, imagem: `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`, fonte: 'gemini-flash' });
    }
  } catch (e) {
    console.log('Gemini Flash falhou:', e.message);
  }

  // 4. Imagen 3 Fast
  try {
    const b64 = await tentarImagen('imagen-3.0-fast-generate-001', promptFull);
    return res.json({ ok: true, imagem: `data:image/png;base64,${b64}`, fonte: 'imagen-fast' });
  } catch (e) {
    console.log('Imagen 3 Fast falhou:', e.message);
  }

  // 5. Imagen 3 Standard
  try {
    const b64 = await tentarImagen('imagen-3.0-generate-001', promptFull);
    return res.json({ ok: true, imagem: `data:image/png;base64,${b64}`, fonte: 'imagen-standard' });
  } catch (e) {
    console.log('Imagen 3 Standard falhou:', e.message);
    return res.status(500).json({ ok: false, erro: 'Todas as fontes falharam: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`\n✓ Leonam OS rodando em http://localhost:${PORT}\n`));
