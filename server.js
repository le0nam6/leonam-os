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
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 2048,
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

    let contextoExterno = '';
    for (const url of urls.slice(0, 5)) {
      try {
        const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
        const texto = r.data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, 1500);
        contextoExterno += `\n\n--- FONTE: ${url} ---\n${texto}`;
      } catch (e) { contextoExterno += `\n\n--- FONTE: ${url} --- (não foi possível acessar)`; }
    }

    const pdfFiles = (req.files || []).filter(f => f.fieldname.startsWith('pdf_'));
    for (const pdfFile of pdfFiles) {
      try {
        const pdfParse = require('pdf-parse');
        const buffer = fs.readFileSync(pdfFile.path);
        const data = await pdfParse(buffer);
        contextoExterno += `\n\n--- DOCUMENTO: ${pdfFile.originalname} ---\n${data.text.slice(0, 2000)}`;
        try { fs.unlinkSync(pdfFile.path); } catch (e) {}
      } catch (e) {}
    }

    if (briefing) contextoExterno += `\n\n--- BRIEFING DO LEONAM ---\n${briefing}`;

    const contextoTotal = contextoVault + (contextoExterno ? `\n\n═══ CONTEXTO EXTERNO FORNECIDO ═══${contextoExterno}` : '');

    let prompt;

    const estiloBase = `
IDENTIDADE DO AUTOR:
Leonam Alves é estrategista de conteúdo baseado em São Luís, Maranhão. Ajuda criativos, designers e freelancers a entenderem a lógica de negócios para construírem carreiras e negócios sustentáveis. Tom: direto, realista, pragmático. Sem metáforas forçadas, sem linguagem "technocêntrica", sem papo motivacional vazio.

ESTILO DE ESCRITA (obrigatório replicar):
- Abre sempre com uma situação concreta que o leitor já viveu, ou uma pergunta direta. Sem introdução longa.
- Parágrafos curtos: 1 a 3 linhas. Nunca blocos pesados.
- Frases de impacto em linha própria: "Isso é exatamente o oposto da verdade.", "Gargalos não são promovidos.", "Atenção é barata. Confiança é cara."
- Usa → para marcar conclusões ou viradas de lógica
- Bold (**) em frases que o leitor vai querer sublinhar
- Subtítulos como afirmações provocativas, não como tópicos descritivos. Ex: "O paradoxo da indispensabilidade" em vez de "Como funciona X"
- Usa experiências pessoais reais: "Quando comecei minha eugência em 2021...", "Eu já. Muitas vezes.", "Aprendi isso da forma difícil."
- Nunca usa: "fosso incopiável", "oceano de ruído digital", "jornada", "ecossistema", "sinergias", "impacto positivo", frases de coach
- ANALOGIAS: máximo UMA por peça. Evitar as desgastadas do mercado de marketing: caçador/fazendeiro, terreno alugado, construir casa na areia, plantar sementes, maratona vs sprint. Se usar analogia, construir a partir de uma situação concreta e específica — não de imagens genéricas de "negócios"
- Assina como "Leo" ou "Leonam" no final
- Tamanho da newsletter: ☕ Mentoria matinal • 5-7 min de leitura`;

    if (tipo === 'carrossel') {
      prompt = `Você é o ghostwriter do Leonam Alves. Escreva um carrossel de Instagram no estilo dele.

${estiloBase}

PADRÕES DOS CARROSSÉIS DO LEONAM:
1. HOOK com nome real e situação concreta (ex: "A Cimed ofereceu um contrato milionário para o Toguro.")
2. Valida parcialmente o argumento oposto antes de destruí-lo
3. Identifica a falha lógica central com precisão — não é opinião, é análise
4. Paradoxo que inverte a conclusão óbvia
5. Dados específicos contextualizados (números reais, nomes reais)
6. Slides de 3-6 linhas quando o argumento precisa — não fragmentado
7. Penúltimo slide inverte quem está na posição de poder (reversão de status)
8. CTA com mecanismo: "Comente MARCA", "Salva esse post" — nunca "Me siga"

Tema: "${tema}"
Ângulo: ${angulo || 'contraintuitivo — questione uma crença que o mercado aceita como verdade'}

Decida antes de escrever:
- Qual caso real ou nome específico usar como âncora?
- Qual é a crença errada a destruir?
- Qual é a virada lógica inesperada?
- Quantos slides o argumento precisa? (mínimo 8, máximo 15)

FORMATO DE SAÍDA:
**SLIDE 1 — GANCHO**
[texto]

**SLIDE 2 — SEGUNDA CHANCE**
[texto]

[continue nomeando cada slide pela função: AGITAÇÃO, CONTEXTO, DESCONSTRUÇÃO, PARADOXO, VIRADA, APLICAÇÃO, REVERSÃO DE STATUS, CTA]

LEGENDA SUGERIDA:
[legenda]

CONHECIMENTO DO VAULT:
${contextoTotal.slice(0, 6000)}
`;

    } else {
      prompt = `Você é o ghostwriter do Leonam Alves. Sua única tarefa é replicar o estilo exato dele.

${estiloBase}

════════════════════════════════
EXEMPLO REAL DE NEWSLETTER DO LEONAM
(Estude o padrão. Replique a estrutura. Não copie o tema.)
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

Siga EXATAMENTE o mesmo padrão do exemplo:
1. ABERTURA: situação concreta vivida por cliente ou pelo Leonam — sem perguntas retóricas, sem "você já se perguntou", sem "imagine que..."
2. 3 SUBTÍTULOS MÁXIMO — com desenvolvimento real, não tópicos rasos
3. EXERCÍCIO FINAL: ação específica com critério claro, não "pergunte a si mesmo"
4. 600-800 palavras — sem exceção
5. Use as notas do vault abaixo para extrair opiniões e cases reais do Leonam

NOTAS DO VAULT:
${contextoTotal.slice(0, 5000)}`;
    }

    const conteudo = await chamarClaude(prompt);
    const notasUsadas = notas.map(n => n.arquivo);
    res.json({ ok: true, conteudo, notasUsadas, tema, tipo });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
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

app.listen(PORT, () => console.log(`\n✓ Leonam OS rodando em http://localhost:${PORT}\n`));
