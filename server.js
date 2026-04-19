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

// ── FRAMEWORKS DE CONTEÚDO ───────────────────────────────────────────────────
function gerarInstrucaoFramework(framework) {
  const blocos = {
    'leonam': '', // estilo padrão — já definido em estiloBase

    'eter-aida': `
════════════════════════════════
FRAMEWORK: ETER PLAYBOOK — AIDA + TENSÃO IDEOLÓGICA + SCAMPER
════════════════════════════════
MOTOR DO CONTEÚDO: Visão de Mundo + Tensão Ideológica
• Visão de Mundo = a crença central do autor sobre como o mercado funciona de verdade
• Tensão Ideológica = o conflito entre essa visão e o que o mercado aceita como verdade — esse conflito gera atenção e pertencimento

ESTRUTURA AIDA:
A — ATENÇÃO: Gancho que provoca a tensão ideológica. Não "isso é importante" — é "aqui está o que você acredita de errado e por quê".
I — INTERESSE: Aprofunda a tensão. Mostra o que o leitor não vê, não sabe ou não quer admitir. O mecanismo oculto do problema.
D — DESEJO: Apresenta a Visão de Mundo correta como mundo possível. Uma nova lente — não lista de dicas.
A — AÇÃO: CTA de pertencimento ou próximo passo. Não "compre agora" — "se você acredita nisso, seu próximo passo é X".

ESCALA DE CRENÇA — identifique o degrau do leitor e escreva para ele:
1. Desconhecimento — não sabe que o problema existe
2. Reconhecimento — percebe o sintoma, não a causa
3. Compreensão — entende a causa, não sabe o que fazer
4. Convicção — sabe o que fazer, precisa de clareza/coragem
5. Pertencimento — já acredita, quer comunidade e validação

MULTIPLICADOR SCAMPER — escolha UM para o ângulo:
S - Substituir: trocar uma crença dominante por nova
C - Combinar: fundir dois conceitos que o mercado trata como separados
A - Adaptar: pegar ideia de outro campo e aplicar ao contexto do leitor
M - Modificar: radicalizar ou minimizar um conceito existente
P - Para outro uso: mostrar o uso correto do que o leitor usa errado
E - Eliminar: tirar o que o mercado acha essencial e mostrar que não precisa
R - Reverter: mostrar o oposto do que todos fazem e por que funciona

TIPO DE CONTEÚDO:
• PORTA (alcance): tese contraintuitiva que atrai quem não te conhece
• CONSTRUÇÃO (crença): aprofunda convicção, eleva escala de crença de 2 para 4
• PERTENCIMENTO (comunidade): valida quem já acredita, cria identidade de grupo

ANTES DE ESCREVER, decida explicitamente: Tensão Ideológica central? Degrau da Escala de Crença? SCAMPER escolhido? Tipo de conteúdo?
`,

    'dan-koe': `
════════════════════════════════
FRAMEWORK: DAN KOE — FILOSOFIA + NEGÓCIO + IDENTIDADE
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Abre com declaração contrária ao senso comum — não pergunta, afirmação
• Sintetiza filosofia (estoicismo, pensamento sistêmico) com aplicação prática de negócio — sem forçar
• Segunda pessoa com autoridade tranquila: "você está preso porque..." — diagnóstico, não acusação
• Cada parágrafo autossuficiente — pode ser retirado e funcionar como citação isolada
• Frases curtas. Alto impacto por linha. Zero desperdício.
• Identidade como produto central: o leitor não compra técnica, compra uma forma de ver o mundo
• Sem urgência artificial — o leitor chega à conclusão sozinho pela lógica empilhada
• Tese central: trabalho criativo e construção do negócio são inseparáveis da construção da identidade

ESTRUTURA:
1. Afirmação de abertura paradoxal (1-2 linhas máximo)
2. Diagnóstico: por que a maioria pensa diferente e qual é o erro
3. Reframe: a lente correta para ver o problema
4. Princípios (3-5) — cada um em linha própria, peso máximo por linha
5. Aplicação: como implementar hoje, não abstratamente
6. Fechamento filosófico: não CTA comercial — chamada à ação interna

TOM: mentor que já passou pelo que descreve. Ritmo deliberado.
`,

    'caderno-jonas': `
════════════════════════════════
FRAMEWORK: CADERNO DO JONAS — ENSAIO INTIMISTA
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Abre com cena ou memória específica e aparentemente banal — que depois revela ponto de entrada para reflexão maior
• NUNCA abre com pergunta retórica, promessa de valor ou afirmação polêmica
• Fluxo contínuo de pensamento — sem subtítulos excessivos, sem bullets, sem estrutura rígida
• Tom de conversa entre amigos inteligentes — íntimo, sem urgência, não performático
• O leitor sai sentindo que passou tempo com alguém, não que aprendeu algo (mesmo que tenha)
• Mistura referências literárias ou culturais com observações cotidianas — naturalmente
• Parágrafos médios a longos com pausas deliberadas — vírgulas para respiração
• Sem CTA comercial — fechamento que ecoa a abertura (círculo)

ESTRUTURA:
1. Cena/memória de abertura (específica, concreta, aparentemente banal)
2. Primeira virada: como essa cena se liga a algo maior
3. Desenvolvimento em fluxo — pensamento processando, não lista
4. Segunda virada ou paradoxo — onde a reflexão chega a lugar inesperado
5. Fechamento circular — ecoa a abertura, sem CTA

TOM: confessional, devagar, sem urgência. Leitura lenta.
`,

    'henri-armelin': `
════════════════════════════════
FRAMEWORK: HENRI ARMELIN — INTELECTUAL ACESSÍVEL / PRECISÃO CONCEITUAL
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Abre com paradoxo ou contradição que o mercado comete
• DEFINE os termos que usa antes de usá-los — não assume que o leitor entende igual
• Didático sem ser condescendente — o leitor sente que está aprendendo, não sendo ensinado
• Vocabulário preciso e sofisticado, mas organizado — sem jargão gratuito
• Estrutura linear clara: cada seção avança logicamente da anterior
• Exemplos reais de mercado: cases, marcas, situações concretas
• Constrói confiança intelectual — o leitor termina sentindo que o autor domina o assunto

ESTRUTURA POR SEÇÃO:
1. Contexto/problema: o que o mercado faz errado e por quê é problema
2. Conceito: defina o termo/framework com precisão antes de avançar
3. Exemplo: case real que demonstra o conceito
4. Princípio extraído: o que o leitor leva para seu contexto
5. Aplicação prática: exercício ou checklist concreto

TOM: professor que também é praticante. Ritmo médio, linear.
`,

    'tay-dantas': `
════════════════════════════════
FRAMEWORK: TAY DANTAS — TÁTICO, TRANSFORMAÇÃO DIRETA
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Abre com número, afirmação polêmica ou promessa de transformação clara e mensurável
• Energia alta, direto ao ponto — sem aquecimento
• Frases muito curtas. Parágrafos de 1-2 linhas máximo.
• Identifica erros comuns antes de mostrar o caminho certo
• Estrutura com passos numerados ou lista de erros vs. soluções
• Cada conteúdo termina com algo concreto que o leitor pode fazer hoje — não abstrato
• CTA direto e específico: "Salva esse post", "Comenta X", "Faz isso hoje"

ESTRUTURA:
1. Gancho: número + afirmação polêmica ("3 erros que fazem seu negócio faturar menos")
2. Validação do problema: por que isso acontece (2-3 linhas, rápido)
3. Erros listados com solução imediata para cada um
4. Virada: o que fazer diferente
5. CTA direto

TOM: mentor no jogo agora, compartilhando o que funciona hoje. Leitura rápida.
`,

    'davi-ribas': `
════════════════════════════════
FRAMEWORK: DAVI RIBAS / ETER — AFORÍSTICO, ESTÉTICA COMO ESTRATÉGIA
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Cada frase lapidada — sem nada desnecessário, peso em cada palavra
• Abre com afirmação aparentemente simples que esconde tensão profunda
• Tom calmamente subversivo: questiona o óbvio sem gritar
• Não explica demais — deixa o leitor completar o raciocínio
• Frases quase aforísticas — funcionam como citações isoladas
• Silêncio entre ideias é parte do estilo — espaço em branco textual
• Fusão entre forma (como a mensagem é construída) e conteúdo (o que ela diz)
• Vocabulário de design e cultura — não de guru de marketing

ESTRUTURA:
1. Afirmação de abertura: simples, aparentemente óbvia, tensão escondida
2. Desconstrução silenciosa: 2-3 linhas que revelam o que a abertura escondia
3. Virada: onde a lente muda completamente
4. Síntese: frase final que condensa tudo — deve funcionar como citação sozinha

TOM: estético, filosófico, levemente provocador. Leitura rápida, densa.
`,

    'schwartz': `
════════════════════════════════
FRAMEWORK: EUGENE SCHWARTZ — 5 NÍVEIS DE CONSCIÊNCIA DO MERCADO
════════════════════════════════
ANTES DE ESCREVER, identifique o nível do público e escreva especificamente para ele:

NÍVEL 1 — COMPLETAMENTE INCONSCIENTE
Leitor não sabe que tem o problema. Abre com história ou contraste antes/depois que desperta o reconhecimento — sem mencionar a solução ainda.

NÍVEL 2 — CONSCIENTE DO PROBLEMA, NÃO DA SOLUÇÃO
Sente a dor, não sabe o que fazer. Nomeie a dor com precisão, valide que é real, então sinalize que existe saída.

NÍVEL 3 — CONSCIENTE DA SOLUÇÃO, NÃO DO PRODUTO
Sabe que existe solução, não sabe que você tem. Posicione seu ângulo/framework como a melhor rota.

NÍVEL 4 — CONSCIENTE DO PRODUTO, NÃO DOS DETALHES
Sabe da sua abordagem, precisa de especificidade. Foco em mecanismo, prova, resultado mensurável.

NÍVEL 5 — TOTALMENTE CONSCIENTE
Só precisa da oferta certa. Seja direto, urgência real, proposta cristalina.

SOFISTICAÇÃO DO MERCADO:
Se o mercado já viu muitas mensagens similares: diferencie pelo mecanismo, inverta a crença dominante, use especificidade extrema.

PRINCÍPIOS:
• Especificidade sempre vence generalidade
• Toda afirmação de benefício deve ser crível e verificável
• O leitor compra com emoção e justifica com lógica — entregue ambos
`,

    'halbert': `
════════════════════════════════
FRAMEWORK: GARY HALBERT — ABERTURA EMOCIONAL / STORYTELLING VISCERAL
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Abre com a dor mais visceral e específica do leitor — cirúrgico, não genérico
• Storytelling pessoal ou de caso real que espelha exatamente a situação do leitor
• "So What?" test: todo parágrafo deve fazer o leitor avançar — se pode cortar sem perda, corta
• Urgência e especificidade em tudo — números reais, situações reais, nomes reais
• Bullets de medo e desejo alternados: "Você vai continuar fazendo X... ou vai finalmente Y"
• Prova social e casos reais como combustível, não decoração
• Fechamento com promessa clara e CTA sem ambiguidade
• Headline carrega o benefício principal — é o anúncio do anúncio

ESTRUTURA:
1. Headline: benefício específico e urgente
2. Abertura emocional: dor visceral narrada com especificidade
3. História de identificação: o leitor se vê na situação
4. Revelação: por que a dor existe (crença errada ou inimigo externo)
5. Solução + prova: o que funciona e por quê
6. Bullets de benefício/medo alternados
7. CTA direto com urgência real

TOM: íntimo, urgente, como carta de um amigo que descobriu algo importante.
`,

    'kennedy': `
════════════════════════════════
FRAMEWORK: DAN KENNEDY — DIRECT RESPONSE / ROI OBRIGATÓRIO
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS:
• Todo conteúdo tem propósito de resposta — o leitor age, não apenas "pensa"
• USP cristalina: por que isso e não o genérico do mercado?
• Urgência e escassez apenas quando reais — nunca fabricadas
• Valor ancorado antes de qualquer CTA
• Garantia ou promessa específica de resultado
• P.S. estratégico: resume benefício principal + urgência (é sempre relido)
• Cada palavra trabalha pela ação — sem palavras decorativas
• Público-alvo hiper-específico: quanto mais segmentado, mais poderoso

ESTRUTURA:
1. Headline com benefício + especificidade + audiência
2. Identificação imediata do leitor-alvo ("Se você é X que enfrenta Y...")
3. Problema amplificado: custo específico de não resolver
4. Solução com mecanismo único
5. Prova: números, casos, antes/depois
6. Oferta: o que inclui, o que garante
7. CTA com próximo passo específico
8. P.S.: benefício principal + urgência em 2 linhas

TOM: direto, sem rodeios, respeita o tempo do leitor.
`,

    'sugarman': `
════════════════════════════════
FRAMEWORK: JOE SUGARMAN — SLIPPERY SLIDE / TRIGGERS PSICOLÓGICOS
════════════════════════════════
PRINCÍPIO CENTRAL — SLIPPERY SLIDE:
Cada frase escrita para uma única finalidade: fazer o leitor ler a próxima. O texto inteiro é uma rampa escorregadia — o leitor desce sem perceber.

COMO CRIAR A RAMPA:
• Curiosity gaps: deixe lacunas de informação que só se fecham na frase seguinte
• Cada parágrafo termina com "isca" para o próximo
• Revelações em camadas — nunca entregue tudo de uma vez
• Primeira frase: mais curta possível, fácil de começar
• Subcabeçalhos funcionam como minigancho, não resumo

TRIGGERS PSICOLÓGICOS (use os que se aplicam):
1. CONSISTÊNCIA: "Como você já sabe que X é verdade, então Y faz sentido"
2. ENVOLVIMENTO: faça o leitor se comprometer com algo pequeno antes
3. URGÊNCIA: baseada em razão específica, nunca fabricada
4. EXCLUSIVIDADE: o leitor faz parte de um grupo seleto que entende isso
5. PROVA SOCIAL: casos específicos, não genéricos
6. AUTORIDADE: por que o autor tem credibilidade para dizer isso
7. RAZÃO: sempre dê uma razão para o que pede — "porque..." sempre aumenta aceitação

ESPECIFICIDADE SENSORIAL:
Descreva conceitos tão específica e sensorialmente que o leitor "experimenta" antes de decidir. Não "você vai melhorar" — "você vai saber exatamente o que dizer quando o cliente perguntar por preço".

TOM: conversacional, curioso, como revelação de insider.
`,

    'hopkins': `
════════════════════════════════
FRAMEWORK: CLAUDE HOPKINS — ADVERTISING CIENTÍFICO / PROVA E ESPECIFICIDADE
════════════════════════════════
PRINCÍPIOS OBRIGATÓRIOS (do Scientific Advertising):
• Especificidade sempre vence generalidade: "aumenta faturamento em 40%" > "aumenta muito"
• Toda afirmação de benefício deve ser testável e crível — sem hipérbole
• Cada headline carrega o benefício completo — quem só lê o título entende a oferta
• Educa enquanto persuade — leitor mais informado compra mais, não menos
• Nomeie o mecanismo: não só o que funciona, mas por que funciona
• Zero desperdício — cada palavra serve a um propósito
• Oferta irresistível: o leitor deve sentir que seria irracional não agir

ESTRUTURA:
1. Headline: benefício específico e mensurável
2. Educação: ensine algo que o concorrente não ensina
3. Mecanismo: como funciona (não magia — processo)
4. Prova: resultado verificável, número real
5. Oferta: clara, justa, específica
6. Razão para agir agora: baseada em fato, não em pressão fabricada

TOM: honesto, específico, educativo — o leitor sente que está sendo respeitado.
`,
  };

  return blocos[framework] || '';
}

// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/conteudo/gerar', upload.any(), async (req, res) => {
  const tema = req.body.tema;
  const tipo = req.body.tipo;
  const angulo = req.body.angulo;
  const framework = req.body.framework || 'leonam';
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

    const secaoFramework = gerarInstrucaoFramework(framework);

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
${secaoFramework}
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
${secaoFramework}
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
    res.json({ ok: true, historico: data || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
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
      const link = item.match(/<link>(https?:\/\/[^<]+)<\/link>/)?.[1]?.trim()
        || item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1]?.trim();
      const srcMatch = item.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
      const fonte = srcMatch?.[2]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1')?.trim()
        || item.match(/<source>([\s\S]*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1')?.trim()
        || titulo?.split(' - ').pop()?.trim() || 'Portal';
      const sourceUrl = srcMatch?.[1]?.trim() || '';
      const dataStr = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
      const tituloLimpo = titulo?.replace(/\s*[-–]\s*[^-–]{2,50}$/, '')?.trim() || titulo;
      return { titulo: tituloLimpo, tituloOriginal: titulo, fonte, sourceUrl, link, dataStr };
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
  // Pool amplo — seleção aleatória garante variedade a cada busca
  const pool = [
    // Marca & posicionamento
    'marca pessoal creator 2025 brasil',
    'posicionamento nicho mercado criativo',
    'branding diferenciação pequenas marcas brasil',
    'personal branding linkedin creator brasil',
    'identidade visual agência freelancer mercado',
    // IA aplicada
    'inteligência artificial criadores conteúdo brasil',
    'IA ferramentas designers produtividade 2025',
    'inteligência artificial emprego criativo futuro',
    'automação marketing agências pequenas brasil',
    // Mercado criativo
    'freelancer precificação honorários brasil 2025',
    'agência pequena crescimento modelo negócio',
    'creator economy monetização brasil',
    'designer cobrar valor percebido projeto',
    'economia criativa brasil tendências',
    // Marketing & conteúdo
    'marketing digital tendências brasil 2025',
    'instagram algoritmo creators estratégia',
    'copywriting persuasão conversão brasil',
    'newsletter email marketing crescimento brasil',
    'carrossel instagram engajamento orgânico',
    'conteúdo estratégico posicionamento digital',
    // Negócios & empreendedorismo
    'empreendedorismo digital solopreneur brasil',
    'negócio pessoal sistemas delegação escalar',
    'precificação valor serviços criativos brasil',
    'consultoria posicionamento estratégia marca',
    // Comportamento & consumo
    'comportamento consumidor digital brasil 2025',
    'tendências consumo marca autêntica',
    'geração z comportamento compra digital',
    'confiança marca relacionamento cliente brasil',
  ];

  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  const selecionados = shuffle(pool).slice(0, 9);
  console.log('Tendências — termos selecionados:', selecionados);

  const noticias = [];
  for (const termo of selecionados) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(termo)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
      const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 9000 });
      const items = r.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items.slice(0, 3)) {
        const titulo = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
        // Link — Google News redirect URL
        const link = item.match(/<link>(https?:\/\/[^<]+)<\/link>/)?.[1]?.trim()
          || item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1]?.trim();
        // Fonte do portal
        const srcMatch = item.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
        const fonte = srcMatch?.[2]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1')?.trim()
          || item.match(/<source>([\s\S]*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1')?.trim()
          || (titulo?.includes(' - ') ? titulo.split(' - ').pop()?.trim() : 'Portal');
        const sourceUrl = srcMatch?.[1]?.trim() || '';
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
        // Título limpo sem " - Nome do Portal" no final
        const tituloLimpo = titulo?.replace(/\s*[-–]\s*[^-–]{2,50}$/, '')?.trim() || titulo;
        if (tituloLimpo && tituloLimpo.length > 10) {
          noticias.push({ titulo: tituloLimpo, tituloOriginal: titulo, fonte, sourceUrl, link, pubDate });
        }
      }
    } catch (e) {
      console.warn('Tendência falhou:', termo, e.message);
    }
  }

  // Remove duplicatas por título similar (primeiros 50 chars, case-insensitive)
  const unicos = noticias.filter((n, i, arr) =>
    arr.findIndex(x => x.titulo.slice(0, 50).toLowerCase() === n.titulo.slice(0, 50).toLowerCase()) === i
  );

  if (unicos.length === 0) return res.json({ ok: true, noticias: [], sugestoes: 'Sem tendências disponíveis no momento.' });

  const prompt = `Você é o assistente editorial do Leonam Alves — estrategista de conteúdo para criativos, designers e freelancers no Brasil.

Linha editorial: marketing de posicionamento, marca pessoal, precificação, gestão de negócios criativos, IA aplicada, copywriting.

Notícias coletadas agora do Google News (${unicos.length} pautas):
${unicos.slice(0, 25).map((n, i) => `${i + 1}. "${n.titulo}" — ${n.fonte}`).join('\n')}

Selecione as 6 pautas com MAIOR potencial para a linha editorial. Prefira pautas que permitam ângulo contraintuitivo ou perspectiva de nicho criativo. Evite pautas genéricas de "dicas".

Para cada uma, entregue EXATAMENTE nesse formato (sem texto extra entre os blocos):

PAUTA: [título limpo, sem nome de veículo, máx 10 palavras]
FONTE: [nome do portal da notícia]
TIPO: newsletter ou carrossel
ÂNGULO: [perspectiva que o Leonam tomaria — contraintuitiva, sem "Descubra" ou "Aprenda", 1 frase]
GANCHO: [primeira linha do conteúdo — situação concreta ou dado, nunca começa com pergunta ao leitor]

---

6 blocos no formato acima. Nada mais.`;

  try {
    const sugestoes = await chamarClaude(prompt);
    res.json({ ok: true, noticias: unicos.slice(0, 25), sugestoes });
  } catch (e) {
    res.json({ ok: true, noticias: unicos, sugestoes: 'Erro ao gerar sugestões: ' + e.message });
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
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ erro: 'prompt obrigatório' });

  // Prompt otimizado — conciso para não explodir a URL
  const tema = prompt.slice(0, 120);
  const promptFull = `${tema}, cinematic lighting, dark moody, professional photography, no text, no watermark`;

  const erros = [];

  // Função auxiliar para Pollinations (POST evita limite de URL)
  async function tentarPollinations(polModel) {
    const seed = Math.floor(Math.random() * 1000000);
    // Usa dimensão menor (720×900) — mais rápido e menos timeout
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptFull)}?width=720&height=900&nologo=true&seed=${seed}&model=${polModel}`;
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 40000 });
    const ct = r.headers['content-type'] || 'image/jpeg';
    if (!ct.startsWith('image/')) throw new Error(`Resposta não é imagem: ${ct}`);
    const b64 = Buffer.from(r.data).toString('base64');
    return { b64, ct };
  }

  // 1. Pollinations flux (mais estável)
  try {
    const { b64, ct } = await tentarPollinations('flux');
    return res.json({ ok: true, imagem: `data:${ct};base64,${b64}`, fonte: 'pollinations-flux' });
  } catch (e) {
    erros.push(`pollinations-flux: ${e.message}`);
    console.log('Pollinations flux falhou:', e.message);
  }

  // 2. Pollinations flux-realism
  try {
    const { b64, ct } = await tentarPollinations('flux-realism');
    return res.json({ ok: true, imagem: `data:${ct};base64,${b64}`, fonte: 'pollinations-realism' });
  } catch (e) {
    erros.push(`pollinations-realism: ${e.message}`);
    console.log('Pollinations flux-realism falhou:', e.message);
  }

  // 3. Gemini image generation (3.1 Flash primeiro, depois fallbacks 2.0)
  try {
    const modelos = [
      'gemini-3.1-flash-image-preview',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp-image-generation',
    ];
    for (const modelo of modelos) {
      try {
        console.log(`Tentando Gemini modelo: ${modelo}`);
        const r = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_KEY}`,
          { contents: [{ parts: [{ text: promptFull }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } },
          { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        const parts = r.data?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (imgPart) {
          console.log(`✓ Gemini gerou imagem com: ${modelo}`);
          return res.json({ ok: true, imagem: `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`, fonte: modelo });
        }
      } catch (modelErr) {
        console.log(`${modelo} falhou: ${modelErr.message}`);
      }
    }
    throw new Error('nenhum modelo Gemini gerou imagem');
  } catch (e) {
    erros.push(`gemini: ${e.message}`);
    console.log('Gemini falhou:', e.message);
  }

  // 4. Imagen 3 Fast (requer billing no Google Cloud)
  try {
    const b64 = await tentarImagen('imagen-3.0-fast-generate-001', promptFull);
    return res.json({ ok: true, imagem: `data:image/png;base64,${b64}`, fonte: 'imagen-fast' });
  } catch (e) {
    erros.push(`imagen-fast: ${e.message}`);
    console.log('Imagen 3 Fast falhou:', e.message);
  }

  return res.status(500).json({ ok: false, erro: 'Todas as fontes falharam', detalhes: erros });
});

app.listen(PORT, () => console.log(`\n✓ Leonam OS rodando em http://localhost:${PORT}\n`));
