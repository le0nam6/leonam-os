require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const VAULT = process.env.VAULT_PATH || path.join(os.homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Second Brain');
const GEMINI_KEY = process.env.GEMINI_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PASTAS_INDEXAR = [
  '02 - Notas Permanentes',
  '03 - Literatura',
];

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

function listarMDs(pasta) {
  const resultado = [];
  if (!fs.existsSync(pasta)) return resultado;
  const entradas = fs.readdirSync(pasta, { withFileTypes: true });
  for (const entrada of entradas) {
    const caminho = path.join(pasta, entrada.name);
    if (entrada.isDirectory()) {
      resultado.push(...listarMDs(caminho));
    } else if (entrada.name.endsWith('.md')) {
      resultado.push(caminho);
    }
  }
  return resultado;
}

async function carregarIndexados() {
  const { data } = await supabase.from('insights').select('arquivo_obsidian');
  return new Set((data || []).map(r => r.arquivo_obsidian).filter(Boolean));
}

async function sincronizar() {
  console.log(`\n🔄 Sincronizando vault: ${VAULT}\n`);

  const indexados = await carregarIndexados();
  console.log(`✓ ${indexados.size} notas já indexadas no Supabase`);

  let novos = 0;
  let erros = 0;
  let ignorados = 0;

  for (const pasta of PASTAS_INDEXAR) {
    const caminhoPasta = path.join(VAULT, pasta);
    const arquivos = listarMDs(caminhoPasta);
    console.log(`\n📁 ${pasta}: ${arquivos.length} arquivos`);

    for (const caminhoArquivo of arquivos) {
      const nomeRelativo = path.relative(VAULT, caminhoArquivo);
      const nomeArquivo = path.basename(caminhoArquivo);

      // Pula se já indexado
      if (indexados.has(nomeArquivo)) {
        ignorados++;
        continue;
      }

      try {
        const conteudo = fs.readFileSync(caminhoArquivo, 'utf8');
        if (conteudo.trim().length < 50) { ignorados++; continue; }

        // Extrai título do frontmatter ou do nome do arquivo
        const tituloMatch = conteudo.match(/^#\s+(.+)/m);
        const titulo = tituloMatch ? tituloMatch[1].trim() : nomeArquivo.replace('.md', '');

        // Detecta tipo pelo frontmatter
        const tipoMatch = conteudo.match(/^tipo:\s*(.+)/m);
        const tipo = tipoMatch ? tipoMatch[1].trim() : 'nota';

        process.stdout.write(`  ↑ ${titulo.slice(0, 60)}...`);

        const embedding = await gerarEmbedding(`${titulo}\n${conteudo.slice(0, 1500)}`);

        const { error } = await supabase.from('insights').insert({
          titulo,
          conteudo,
          origem: nomeRelativo,
          tipo,
          arquivo_obsidian: nomeArquivo,
          embedding
        });

        if (error) throw new Error(error.message);

        console.log(' ✓');
        novos++;

        // Delay para não estourar rate limit do Gemini
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.log(` ✗ ${e.message}`);
        erros++;
      }
    }
  }

  console.log(`\n════════════════════════════════`);
  console.log(`✓ Novos indexados: ${novos}`);
  console.log(`→ Já existentes:   ${ignorados}`);
  console.log(`✗ Erros:           ${erros}`);
  console.log(`════════════════════════════════\n`);
}

sincronizar().catch(e => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
