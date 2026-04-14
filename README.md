# Leonam OS — Segundo Cérebro

Aplicação local que roda no navegador. Sem necessidade de conta, sem cloud.

## Como instalar (primeira vez)

1. Abra o Terminal (Cmd + Espaço, digita "Terminal")
2. Navegue até a pasta onde salvou o projeto:
   ```
   cd /caminho/para/leonam-os
   ```
3. Execute:
   ```
   bash iniciar.sh
   ```
4. Abra o navegador em: **http://localhost:3747**

## Como usar no dia a dia

Toda vez que quiser usar, abra o Terminal e rode:
```
bash iniciar.sh
```

Depois abra **http://localhost:3747** no navegador.

## O que já funciona

- **Ingestão de Notas** — cola qualquer texto e extrai convicções
- **Ingestão de YouTube** — cola a URL e transcreve automaticamente  
- **Ingestão de PDF** — arrasta um livro e extrai os insights
- **Biblioteca** — visualiza todas as convicções salvas
- **Exportar pro Obsidian** — envia direto para o vault

## Onde ficam os dados

- Banco de dados: `~/leonam-os.db`
- Obsidian: caminho configurado no server.js

## Próximas funcionalidades (Fase 2)

- Gerador de posts para Substack
- Gerador de roteiro de carrossel Instagram
- Bot de pesquisa de pautas quentes
