-- 1. Habilitar extensão de vetores
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Criar tabela principal
CREATE TABLE IF NOT EXISTS insights (
  id BIGSERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  conteudo TEXT,
  origem TEXT,
  tipo TEXT DEFAULT 'nota',
  arquivo_obsidian TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  embedding VECTOR(3072)
);

-- 3. Índice para busca vetorial eficiente
CREATE INDEX IF NOT EXISTS insights_embedding_idx
  ON insights USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Função de busca semântica
CREATE OR REPLACE FUNCTION match_insights(
  query_embedding VECTOR(3072),
  match_count INT DEFAULT 15,
  filter_tipo TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  titulo TEXT,
  conteudo TEXT,
  origem TEXT,
  tipo TEXT,
  arquivo_obsidian TEXT,
  criado_em TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    insights.id,
    insights.titulo,
    insights.conteudo,
    insights.origem,
    insights.tipo,
    insights.arquivo_obsidian,
    insights.criado_em,
    1 - (insights.embedding <=> query_embedding) AS similarity
  FROM insights
  WHERE
    embedding IS NOT NULL
    AND (filter_tipo IS NULL OR insights.tipo = filter_tipo)
  ORDER BY insights.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 5. Migrar dados do JSON antigo (rodar manualmente se precisar)
-- Use o endpoint POST /api/migrar para importar leonam-os-db.json
