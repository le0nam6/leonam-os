#!/bin/bash

echo ""
echo "╔══════════════════════════════════╗"
echo "║       Leonam OS — Instalação     ║"
echo "╚══════════════════════════════════╝"
echo ""

# verifica node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js não encontrado. Instale em https://nodejs.org"
  exit 1
fi

echo "✓ Node.js $(node -v) encontrado"
echo ""
echo "📦 Instalando dependências..."
npm install --silent

if [ $? -ne 0 ]; then
  echo "❌ Erro na instalação. Tente rodar: npm install"
  exit 1
fi

echo "✓ Dependências instaladas"
echo ""
echo "🚀 Iniciando Leonam OS..."
echo "   Acesse: http://localhost:3747"
echo "   (Ctrl+C para parar)"
echo ""
node server.js
