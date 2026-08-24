# Nesstech · Workana — painel de propostas

Painel local (roda só na sua máquina) para monitorar vagas novas no Workana compatíveis
com seu perfil, gerar rascunhos de proposta com IA, e enviar **com um clique seu** —
nunca sozinho.

## Como funciona

1. Um agendador em segundo plano varre a listagem de vagas do Workana a cada N minutos
   (configurável), filtra por palavras-chave/orçamento, e gera um rascunho de proposta
   com IA para cada vaga nova.
2. Você abre o painel, revisa/edita o rascunho de cada vaga.
3. Só quando você clica em **"Enviar proposta no Workana"** é que o sistema abre uma
   sessão de navegador e efetivamente envia a proposta — usando exatamente o texto que
   está na tela naquele momento.
4. O mesmo agendador volta periodicamente em cada vaga já enviada (aba **Respondidas**)
   para conferir se o status do projeto mudou ou se há atividade nova — e sinaliza pra
   você acompanhar. Ele só lê a página, nunca escreve nada nela sozinho: responder ao
   cliente é sempre você quem faz, direto no Workana (o painel te leva até lá com um
   link em cada vaga).

**Isso não é um robô de spam.** Ele não envia nada sozinho, e não responde clientes
sozinho. A varredura, a geração de rascunho e a checagem de respostas são automáticas;
enviar uma proposta ou responder um cliente é sempre um clique/ação sua. Isso é
intencional: enviar propostas sem revisão humana normalmente viola os Termos de Uso do
Workana e pode banir sua conta, além de gerar propostas de baixa qualidade para os
clientes.

## Setup

### 1. Instalar dependências

```bash
npm install
```

O `postinstall` já baixa o Chromium do Playwright. Se falhar, rode manualmente:

```bash
npx playwright install chromium
```

### 2. Rodar

```bash
npm start
```

Abra http://127.0.0.1:4173 no navegador. O servidor só escuta em `127.0.0.1`
(localhost) — não fica acessível de fora da sua máquina.

### 3. Primeiro acesso

Na primeira vez, o painel pede pra você **criar uma senha mestra**. Essa senha nunca é
salva — ela só existe na sua cabeça. Ela é usada para derivar a chave que criptografa
(AES-256-GCM) suas credenciais do Workana e a chave de IA dentro de `data/db.json`.
Sem essa senha, ninguém (nem você) consegue ler esses dados do arquivo.

Toda vez que reiniciar o servidor, você precisa desbloquear o cofre de novo com a
mesma senha.

### 4. Configurar credenciais

No painel, abra **Configurações** e preencha:

- **Email e senha do Workana** — ficam criptografados localmente, nunca em texto puro.
- **Chave de IA (Google Gemini, gratuito)** — crie a sua conta e a chave em
  https://aistudio.google.com/app/apikey (tem uso gratuito generoso). Cole a chave
  aqui.
- **Seu perfil** — um resumo da sua experiência, usado pela IA para personalizar as
  propostas.
- **Filtros de busca** — palavras-chave, idioma, orçamento mínimo, intervalo da
  varredura automática.

## Por que uma janela de navegador abre (minimizada) em vez de rodar 100% invisível

O Workana fica atrás da proteção anti-bot da Cloudflare. Na prática (testado):
navegador headless (invisível) é bloqueado e não retorna nenhuma vaga; um navegador
"normal" passa sem problema. Então o app abre um Chromium de verdade — sem nenhum
truque de fingerprint ou spoofing — só com a flag `--start-minimized`, então ele
nunca aparece na sua frente nem precisa do seu mouse/teclado. Uma única janela é
reaproveitada tanto para a varredura quanto para os envios.

Se quiser ver a janela por algum motivo (ex: debugar), rode com:

```bash
# Windows (PowerShell)
$env:WORKANA_SHOW_WINDOW="true"; npm start

# Windows (Git Bash) / macOS / Linux
WORKANA_SHOW_WINDOW=true npm start
```

## Importante: valide o envio de proposta antes de confiar nele

Os seletores usados para clicar em "Enviar proposta" e preencher o formulário
(`config/selectors.json`) foram construídos a partir de padrões comuns do Workana,
mas o formulário de proposta só aparece pra quem está logado — não deu pra confirmar
os seletores exatos sem autenticar (e isso eu não faço por você).

Antes de usar de verdade, rode com `WORKANA_SHOW_WINDOW=true` (veja acima), dispare
um envio de teste (em uma vaga real ou de mentira) e observe se ele encontra os
campos certos. Se algum campo não for encontrado, clique com o botão direito nele
no navegador → Inspecionar, veja o `name`/`id` real, e ajuste `config/selectors.json`.

## Como a checagem de respostas funciona

Segundo a própria ajuda do Workana, depois que você manda uma proposta a conversa com
o cliente e o status do projeto (Avaliando propostas / Aguardando depósito / Trabalhando
/ Finalizado / Cancelado) ficam na mesma página da vaga — não existe uma caixa de
mensagens separada. Então, pra cada vaga com proposta enviada, o painel:

1. Guarda um "retrato" (hash + texto) da página logo depois do envio.
2. Periodicamente (e quando você clica em "Verificar respostas") revisita a mesma
   página e compara com o retrato anterior.
3. Se mudou, marca a vaga como **Respondida** e guarda o texto da página pra você ler
   no painel — sem precisar abrir o Workana toda hora.
4. O status do projeto é detectado procurando as frases conhecidas do Workana no texto
   da página (não depende de nenhuma classe CSS específica, então é mais resistente a
   mudanças no site).

Isso é só leitura — não manda nada. Pra responder o cliente, o painel te dá um link
direto pra vaga no Workana.

## Estrutura

```
server/
  index.js              servidor Express
  db.js                 armazenamento local (data/db.json)
  vault.js               criptografia AES-256-GCM das credenciais
  routes/                 API REST (auth, settings, jobs)
  services/
    browserManager.js     navegador Chromium compartilhado (minimizado)
    workanaAuth.js        login + sessão persistente no Workana (Playwright)
    workanaScraper.js      varredura da listagem de vagas
    workanaSubmit.js       preenchimento e envio da proposta (ação manual)
    workanaResponses.js    checagem de respostas/status das vagas enviadas
    aiProposal.js           geração de rascunho via Gemini
    scanAndDraft.js         busca vagas novas + gera rascunhos
    scheduler.js             roda scanAndDraft + checkResponses a cada N minutos
config/selectors.json    seletores do formulário de proposta (ajustável)
public/                  dashboard (HTML/CSS/JS puro, sem build)
data/                    banco local + sessão do navegador (gitignored)
```

## Segurança

- O servidor só escuta em `127.0.0.1` — não exponha essa porta na rede.
- `data/` está no `.gitignore` — nunca commite esse diretório (contém credenciais
  criptografadas e a sessão do navegador).
- A senha mestra não é armazenada em lugar nenhum — só um "verificador" criptografado
  com ela, para conferir se você digitou certo.
