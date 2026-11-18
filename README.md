# Nesstech · Workana — painel de propostas

Painel (roda na sua máquina ou num servidor Ubuntu) para monitorar vagas novas no Workana compatíveis
com seu perfil, avisar as boas no WhatsApp (via WAHA), gerar rascunhos de proposta com IA e **enviar as propostas sozinho, sem
clique** — ou com clique, se você preferir revisar cada uma.

## Aviso

Enviar propostas sem revisão humana normalmente **viola os Termos de Uso do Workana** e
pode resultar em **banimento da conta**. Os limites deste painel (teto diário, score
mínimo, intervalo entre envios, circuit breaker) reduzem o risco, não o eliminam. O modo
automático vem desligado de fábrica e exige dois passos deliberados para ligar.

## Como funciona

1. Um agendador em segundo plano varre a listagem de vagas do Workana a cada N minutos
   (configurável), filtra por palavras-chave/orçamento, e gera um rascunho de proposta
   com IA para cada vaga nova.
2. Logo depois de cada varredura, a **fila automática** roda. Para cada vaga com rascunho
   pronto ela aplica, nesta ordem:
   - filtros duros: teto de propostas já recebidas, orçamento mínimo, termos vetados;
   - um **score de 0 a 100** dado pela IA, avaliando o encaixe com o seu perfil e os
     riscos do projeto;
   - um preflight na própria página da vaga — já me candidatei? vaga fechada? conta sem
     Conexões?;
   - preenchimento com **leitura de volta de cada campo**: se o valor não ficou no campo,
     aborta em vez de enviar lixo;
   - clique em enviar e **confirmação de que o Workana aceitou**. Sem confirmação, a vaga
     não é marcada como enviada — para que uma retentativa não duplique a proposta.
3. Você pode continuar enviando manualmente pelo painel a qualquer momento.
4. O mesmo agendador volta periodicamente em cada vaga já enviada (aba **Respondidas**)
   para conferir se o status do projeto mudou. Isso é só leitura — responder ao cliente é
   sempre você, direto no Workana (o painel te leva até lá com um link em cada vaga).

### As três travas antes de qualquer envio automático

| Trava | Onde se liga | Padrão |
|---|---|---|
| `enabled` | Configurações › Envio automático | desligado |
| `dryRun` | Configurações › Envio automático | ligado (preenche e não envia) |
| `armed` | botão "Armar envio real" | desarmado |

Enquanto `armed` for falso, **todo ciclo roda como dry-run**, mesmo com a fila ligada e o
dry-run desmarcado. Isso é proposital: os seletores do formulário de proposta só podem
ser validados com uma conta logada, então o sistema se recusa a enviar às cegas.

### Limites e o circuit breaker

Configuráveis em Configurações › Envio automático: máximo por dia, máximo por ciclo,
score mínimo da IA, teto de propostas já recebidas na vaga, orçamento mínimo, intervalo
entre envios, valor e prazo a propor, e uma lista de termos que vetam o envio.

Além disso, a fila se pausa sozinha:

| Situação | Pausa |
|---|---|
| Conta sem Conexões | 12h |
| 2FA pedido / credenciais recusadas | 24h |
| Seletor do formulário não encontrado | 12h |
| Envio sem confirmação do Workana | 6h |
| 3 falhas seguidas de qualquer tipo | 90 min |

O motivo e o horário de liberação aparecem na barra do topo do painel, com um botão
"Retomar" para destravar antes da hora.

## Antes de armar: validando os seletores

O formulário de proposta só existe para quem está logado, então os valores em
`config/selectors.json` começam como um chute. Duas ferramentas no modal de cada vaga
resolvem isso:

- **Diagnosticar formulário** — abre a vaga com sua sessão, tenta abrir o formulário e
  lista os elementos reais de cada campo, já sugerindo o JSON pronto para colar em
  `config/selectors.json`. Só lê, nunca preenche nem clica em enviar.
- **Testar envio (sem enviar)** — preenche o formulário inteiro com a proposta de
  verdade, confere que cada valor ficou no campo certo, tira um print e **para antes do
  clique final**. Não gasta Conexão e não posta nada.

Quando o "Testar envio" passar em uma vaga real, aí sim vale armar.

Toda falha salva print, HTML e texto da página em `data/diagnostics/`.

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

## Avisos de boas oportunidades no WhatsApp (WAHA)

A cada varredura (agendada ou manual), toda vaga **nova** que passou nos filtros de
busca é pontuada pela IA (o mesmo score de 0 a 100 da fila automática). Se o score for
**igual ou maior que o mínimo** (padrão 70), o painel manda pelo WAHA, para cada número
configurado, uma mensagem com:

- título da vaga;
- faixa de pagamento oferecida pelo cliente;
- score da IA e quantas propostas a vaga já recebeu;
- link da vaga no Workana, onde fica o botão "Enviar proposta".

Detalhes:

- Os números padrão são `5511997135040` e `5521992015506`; dá para trocar, ligar/desligar
  e ajustar o score mínimo em **Configurações › Avisos por WhatsApp**, que também tem um
  botão **Enviar mensagem de teste** e mostra se a sessão do WAHA está `WORKING`.
- Antes de enviar, o painel pergunta ao WAHA qual é o ID real de WhatsApp do número
  (`/api/contacts/check-exists`) — contas brasileiras antigas ficam sem o 9º dígito no ID,
  e mandar para o ID errado não chega a lugar nenhum.
- Cada vaga é avisada uma vez só. A entrega é registrada por número: se um falhar, só
  ele é tentado de novo no ciclo seguinte (até 3 tentativas por vaga).
- Só vagas capturadas nas últimas 24h são avisadas (ligar o recurso não dispara aviso
  de vaga antiga), no máximo 10 avisos por ciclo.
- Precisa da chave de IA configurada (sem score não dá para saber se é "boa").

A conexão com o WAHA vem de variáveis de ambiente (veja `deploy/env.example`):

| Variável | Padrão | Para quê |
|---|---|---|
| `WAHA_URL` | — (obrigatória) | ex. `http://127.0.0.1:3000` |
| `WAHA_API_KEY` | vazio | mesmo valor de `WAHA_API_KEY` do container do WAHA |
| `WAHA_SESSION` | `default` | nome da sessão com o WhatsApp conectado |

## Rodando num servidor Ubuntu (junto do WAHA)

O Workana bloqueia navegador headless, então no servidor o Chromium roda como janela
normal dentro de um **display virtual (Xvfb)**. O script de instalação cuida disso, do
Node 20+, das bibliotecas do Chromium, de um usuário de serviço (`workana`) e do serviço
systemd.

```bash
git clone <repo> nesstech-workana && cd nesstech-workana
sudo bash deploy/install.sh
sudo nano /etc/nesstech-workana/env      # WAHA_URL / WAHA_API_KEY / WAHA_SESSION
sudo systemctl restart nesstech-workana
```

Para atualizar depois: `git pull && sudo bash deploy/install.sh` (não mexe em
`/etc/nesstech-workana` nem nos dados).

| O quê | Onde |
|---|---|
| Código | `/opt/nesstech-workana` |
| Dados (cofre, sessão, vagas, diagnósticos) | `/var/lib/nesstech-workana/data` |
| Configuração (env) | `/etc/nesstech-workana/env` (root, 0600) |
| Serviço | `systemctl status nesstech-workana` · `journalctl -u nesstech-workana -f` |

**Acesso ao painel:** ele continua escutando só em `127.0.0.1` (não tem login próprio
depois que o cofre é desbloqueado). Do seu computador:

```bash
ssh -L 4173:127.0.0.1:4173 usuario@servidor
```

e abra http://127.0.0.1:4173. Se mesmo assim quiser expor, defina `HOST` no env e
coloque um proxy com autenticação na frente.

**Desbloqueio automático após reinício:** o agendador só roda com o cofre desbloqueado.
Num servidor, ninguém está lá para digitar a senha mestra depois de um reboot, então dá
para gravá-la num arquivo legível só pelo serviço:

```bash
sudo install -m 640 -o root -g workana /dev/stdin /etc/nesstech-workana/master-password
# digite a senha, Enter, Ctrl+D
sudo systemctl restart nesstech-workana
```

O env já aponta para esse arquivo (`WORKANA_MASTER_PASSWORD_FILE`). Troca consciente:
quem tiver root no servidor consegue ler a senha e decriptar `db.json`. Sem o arquivo,
desbloqueie pelo painel depois de cada reinício.

**Migrando os dados desta máquina:** para levar cofre, configurações e a sessão já
logada do Workana (evita login/2FA no servidor), copie a pasta `data/` com o serviço
parado:

```bash
# daqui (pare o painel local antes):
scp -r data usuario@servidor:/tmp/workana-data
# no servidor:
sudo systemctl stop nesstech-workana
sudo cp -r /tmp/workana-data/. /var/lib/nesstech-workana/data/
sudo chown -R workana:workana /var/lib/nesstech-workana/data
sudo rm -rf /tmp/workana-data
sudo systemctl start nesstech-workana
```

## Testes

```bash
npm test
```

Cobre o parsing de orçamento, os avisos de WhatsApp (com o WAHA simulado) e, principalmente, o pipeline de decisão da fila
automática com o navegador e a IA substituídos por stubs — cada caso verifica que ela
**se recusa** a enviar quando deveria (score baixo, vaga lotada, termo vetado, orçamento
ilegível, rascunho vazio, teto diário, não armada). Os testes usam um diretório de dados
descartável (`WORKANA_DATA_DIR`) e nunca tocam no seu `data/`.

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
  db.js                 armazenamento local (data/db.json, override: WORKANA_DATA_DIR)
  vault.js               criptografia AES-256-GCM das credenciais
  routes/                 API REST (auth, settings, jobs + /jobs/auto/*)
  services/
    browserManager.js     navegador Chromium compartilhado (minimizado)
    pageState.js          distingue Cloudflare / 2FA / anônimo / logado + diagnósticos
    workanaAuth.js        login + sessão persistente no Workana (Playwright)
    workanaScraper.js      varredura da listagem de vagas
    workanaSubmit.js       preenchimento, verificação e envio da proposta
    selectorProbe.js       descobre os seletores reais do formulário (só leitura)
    autoSend.js            fila automática: filtros, score, tetos, circuit breaker
    workanaResponses.js    checagem de respostas/status das vagas enviadas
    aiProposal.js           rascunho + score da vaga via Gemini
    waha.js                 cliente HTTP do WAHA (WhatsApp)
    opportunityNotifier.js  aviso no WhatsApp das vagas novas com score alto
    scanAndDraft.js         busca vagas novas + gera rascunhos
    scheduler.js             scanAndDraft + runAutoSend + checkResponses a cada N min
config/selectors.json    seletores do formulário de proposta (ajustável)
public/                  dashboard (HTML/CSS/JS puro, sem build)
deploy/                  instalação no Ubuntu: install.sh, unit systemd, env.example
test/                    smoke.js + autosend.js + whatsapp.js (npm test)
data/                    banco local, sessão do navegador e diagnósticos (gitignored)
```

## Segurança

- O servidor só escuta em `127.0.0.1` — não exponha essa porta na rede.
- `data/` está no `.gitignore` — nunca commite esse diretório (contém credenciais
  criptografadas e a sessão do navegador).
- A senha mestra não é armazenada em lugar nenhum — só um "verificador" criptografado
  com ela, para conferir se você digitou certo.
