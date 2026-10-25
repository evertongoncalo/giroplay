# GiroPlay

Player de vídeos em **loop contínuo e sem corte** para painéis de rua (LED / outdoor), feito para rodar num PC Windows ligado ao painel por HDMI.

Você joga os vídeos numa **pasta do Google Drive**, de qualquer lugar (celular, outro PC). O GiroPlay vigia a pasta, confere cada vídeo, e o coloca **no fim do ciclo**, sem interromper o que está passando.

> Status: versão 0.1.0, testada em um PC de desenvolvimento. Veja [o que foi e o que não foi testado](#o-que-foi-medido-e-o-que-não-foi).

---

## Como funciona

```
Você (celular / PC, de qualquer lugar)
        │  coloca o vídeo na pasta do Google Drive
        ▼
Pasta sincronizada no PC do painel
        │
        ▼
 PORTEIRO  ── espera o arquivo parar de mudar (upload terminou)
           ── confere com ffprobe (abre? tem duração? tem imagem?)
           ── copia, ou converte para H.264 / até 1920x1080 se precisar
           ── decodifica tudo uma vez para pegar arquivo corrompido
        │  só vídeo íntegro passa
        ▼
 BIBLIOTECA LOCAL  (cópia no disco do PC; o player nunca toca direto do Drive)
        │
        ▼
 PLAYER DE 2 CAMADAS  ──►  tela cheia  ──►  HDMI  ──►  painel
```

### Por que não pisca entre um vídeo e outro

Há dois `<video>` empilhados. Enquanto o da frente toca, o de trás já carregou o **próximo** vídeo, parado no primeiro quadro e quase transparente (2% de opacidade). Perto do fim do atual, o de trás começa a tocar e, assim que o primeiro quadro dele aparece de fato na tela, sobe a 100%. O vídeo que acabou fica no último quadro até lá: nunca há tela preta.

> O vídeo de trás fica **por cima**, quase transparente. Na primeira versão ele ficava escondido atrás do da frente, e a gravação da tela mostrou 1 quadro preto (17 ms) em **toda** troca. A causa provável é o navegador não desenhar um vídeo 100% coberto; não inspecionei o compositor para confirmar, mas deixar o vídeo de trás por cima eliminou o defeito nas medições (veja [Medições](#o-que-foi-medido-e-o-que-não-foi)).

### Regras do ciclo

| Situação | O que acontece |
|---|---|
| Vídeo novo chega | Entra no **fim** do ciclo, depois que o upload terminar e o vídeo for conferido |
| Vários chegam juntos | Entram na ordem do nome (`01_`, `02_`…) na primeira carga; depois, na ordem em que ficam prontos |
| Vídeo com o **mesmo nome** é enviado de novo | Substitui o antigo **mantendo a posição** |
| Vídeo apagado da pasta | Sai do ciclo 30 s depois. Se estiver tocando, termina primeiro |
| **Todos** somem de uma vez | O app espera 10 min antes de esvaziar (provável falha do Drive, não exclusão) |
| Pasta do Drive some / desconecta | O painel **continua tocando** o que já tem na cópia local |
| Arquivo cortado ou corrompido | **Recusado** e anotado com o motivo. Nunca entra no ciclo |
| Nenhum vídeo no ciclo | Mostra a tela de espera do GiroPlay (nunca fica preto) |
| Vídeo trava ou não abre durante a exibição | Pula para o próximo e tira o problemático do ciclo |

O GiroPlay **nunca altera nem apaga** arquivos da pasta do Drive. Ele só lê. A única coisa que escreve ali é a pasta `_giroplay` (relatório de status, veja abaixo).

Formatos aceitos: `mp4, m4v, mov, mkv, avi, webm, wmv, mpg, mpeg, mts, m2ts, flv, 3gp`. Vídeos que já são MP4 H.264 até 1920x1080 tocam como estão (só copiados); os demais são convertidos.

---

## Instalação

### 1. No PC do painel

1. Instale o **Google Drive para computador** e entre na sua conta.
2. Crie uma pasta só para o painel (por exemplo `Painel`) e deixe-a **disponível off-line / espelhada**, para os arquivos ficarem de fato no disco do PC. (O modo "streaming" também funciona, mas cada vídeo novo precisa ser baixado na primeira leitura.)
3. Instale o GiroPlay (`GiroPlay Setup x.y.z.exe`) ou rode do código-fonte (veja [Desenvolvimento](#desenvolvimento)).
4. Na primeira abertura, a janela de **configurações** aparece: escolha a pasta do Drive, a tela do painel e clique em **Salvar**.

### 2. Ligação com o painel

O GiroPlay usa **tela cheia** na tela escolhida. Com HDMI direto, ele passa o que está na tela do PC para o painel.

- **Duas telas (estendida):** o painel é a segunda tela; o GiroPlay a usa sozinho, e você continua usando a principal.
- **Tela única / espelhada:** o GiroPlay ocupa a tela inteira. Para abrir as configurações: `Ctrl + Alt + G` ou o ícone na bandeja.
- Se a controladora do painel lê só uma parte da saída HDMI, ajuste a resolução do Windows para a que a controladora espera.

### 3. Rodar 24 h

- Marque **"Abrir o GiroPlay junto com o Windows"** nas configurações (só no app instalado).
- O **guardião** reabre o app se ele cair ou travar (veja abaixo).
- O app impede a tela de apagar/descansar enquanto roda. Mesmo assim, desative a suspensão e o bloqueio automático do Windows e as atualizações que reiniciam o PC fora de hora.

---

## Uso no dia a dia

| Quero… | Faça |
|---|---|
| Colocar um vídeo no ar | Envie para a pasta do Drive |
| Tirar um vídeo | Apague da pasta do Drive |
| Trocar um vídeo mantendo a posição | Envie outro com o **mesmo nome** |
| Controlar a ordem | Use prefixos de nome (`01_`, `02_`…) na primeira carga |
| Abrir as configurações | `Ctrl + Alt + G`, ou o ícone do GiroPlay na bandeja |
| Fechar o GiroPlay | Configurações → **Sair do GiroPlay** (Alt+F4 não fecha, de propósito) |

### Acompanhar sem ir até o painel

O GiroPlay grava a cada 1 minuto, dentro da pasta do Drive:

```
Painel/_giroplay/STATUS.txt        ← abra no app do Drive do celular
Painel/_giroplay/status.json       ← o mesmo, para quem quiser ler por programa
Painel/_giroplay/exibicoes-2026-10.csv   ← comprovante de veiculação
```

`STATUS.txt` mostra o que está tocando, a lista do ciclo, o que está sendo processado ou esperando, e os vídeos **recusados com o motivo**. Se o horário em "Atualizado em" ficar parado, o painel está desligado ou sem internet.

O CSV tem uma linha por exibição (início, fim, duração, vídeo, se tocou completo) e abre direto no Excel. É o comprovante para o anunciante.

---

## Guardião (reabre sozinho)

Ao iniciar, o app lança um processo pequeno que o vigia:

| Situação | O que o guardião faz |
|---|---|
| O processo do app some (queda, falta de memória) | Reabre em poucos segundos |
| O app fica 90 s sem dar sinal de vida (travado) | Encerra e reabre |
| O app fecha pelo menu **Sair** | Não reabre; o guardião encerra |
| O app cai de novo logo após abrir | Espera 15 s antes de tentar outra vez (evita laço de reaberturas) |

Limitação: o "Finalizar tarefa" do Gerenciador de Tarefas encerra a árvore de processos inteira, incluindo o guardião. Para fechar de propósito use o menu **Sair**.

---

## Configuração avançada

As opções da janela ficam em `%LOCALAPPDATA%\GiroPlay\config.json`. Chaves adicionais (edite com o app fechado):

| Chave | Padrão | Para que serve |
|---|---|---|
| `fit` | `contain` | `contain` mostra inteiro (pode ter faixas pretas), `cover` preenche cortando, `fill` estica |
| `maxWidth` / `maxHeight` | `1920` / `1080` | Acima disso o vídeo é reduzido na conversão |
| `maxFps` | `60` | Acima disso a conversão limita o fps |
| `normalize` | `auto` | `auto` converte só o necessário, `always` converte tudo, `never` só copia |
| `audio` | `false` | Painel de rua costuma ser mudo |
| `stableSeconds` | `10` | Quanto tempo o arquivo precisa ficar sem mudar antes de ser processado |
| `missingGraceSec` | `30` | Tolerância antes de tirar do ciclo um vídeo apagado |
| `wipeGuardSec` | `600` | Tolerância quando **todos** os vídeos somem de uma vez |
| `libraryFolder` | vazio | Onde fica a cópia local (padrão: `%LOCALAPPDATA%\GiroPlay\biblioteca`) |
| `statusToDrive` | `true` | Grava o `_giroplay` dentro da pasta do Drive |
| `guardian` | `true` | Liga o guardião |

Arquivos de apoio em `%LOCALAPPDATA%\GiroPlay\`: `logs\` (14 dias), `exibicoes\` (CSV), `biblioteca\` (cópia local + `manifest.json` com a ordem do ciclo).

---

## O que foi medido e o que não foi

**PC de teste:** Windows 11, AMD Ryzen 3 3200G (Vega 8), 13,9 GB de RAM, tela 1920x1080. Vídeos de teste H.264 1920x1080, 30 fps.

### Trocas sem corte (gravação da tela com ffmpeg + `blackdetect`)

A ferramenta `tools/measure.js` abre o app, grava a tela a 60 fps (Desktop Duplication) e procura quadros pretos (`blackdetect`, a partir de 10 ms) e congelamentos de 0,25 s ou mais (`freezedetect`).

| Versão | Cenário | Trocas na gravação | Quadros pretos | Congelamentos |
|---|---|---|---|---|
| Vídeo de trás **escondido** atrás do da frente | janela 640x360, 60 s | 15 | **15** (1 quadro de 17 ms em toda troca) | 0 |
| Vídeo de trás por cima a 2% de opacidade (atual) | janela 640x360, 120 s | 30 | **0** | 0 |
| Idem | **tela cheia** 1920x1080, 60 s | 15 | **0** | 0 |

Pelo lado do player (17 a 39 trocas por execução): tempo entre o `play()` e a imagem do próximo aparecer 16 ms (mediana), no máximo 32 ms; nenhuma troca ficou sem quadro; em algumas trocas os últimos ~55 ms (no máximo 58 ms) do vídeo anterior são cobertos pelo próximo. O erro é sempre para esse lado, nunca para o vídeo ficar parado esperando.

Ressalva: na tela cheia a gravação pegou ~47 quadros/s em vez de 60, porque o PC estava ocupado. Quadros soltos podem esconder um preto isolado, mas com 15 trocas limpas seguidas (contra 15 de 15 com preto antes da correção) o defeito não está escapando.

### Memória

Teste **acelerado** de 16 minutos (`node tools/measure.js --soak --seconds=900`): clipes Full HD de 2 s em loop, cerca de 450 trocas, janela 640x360, amostra a cada 15 s.

| Processo | Após 15 s | No fim (16 min) | Máximo |
|---|---|---|---|
| Total do app | 343 MB | 351 MB | 361 MB |
| Tela (renderer) | 83 MB | 93 MB | 95 MB |
| GPU | 129 MB | 127 MB | 136 MB |
| Navegador (principal) | 87 MB | 89 MB | 90 MB |

Não houve crescimento contínuo: o total oscila em torno de ±10 MB. A tela (renderer) subiu de 83 para ~93 MB nos primeiros 7 minutos e depois ficou estável. Não houve erro nem aviso no log.

Neste teste, das últimas 400 trocas, **5 tiveram o vídeo anterior parado de 3 a 29 ms** (no máximo 1 quadro a 30 fps) antes do próximo aparecer. Todas ocorreram nos primeiros ~3 minutos, enquanto outros testes pesados (conversão de vídeo, outro Electron) rodavam em paralelo no mesmo PC; nos ~10 minutos seguintes, com o PC livre, nenhuma. Observação: o detector de congelamento da gravação de tela só pega paradas de 0,25 s ou mais; paradas menores só aparecem nesta medição feita dentro do player.

### Porteiro e biblioteca: 21 testes automáticos (`npm test`)

Cobrem, com vídeos reais gerados pelo ffmpeg: arquivo chegando **devagar** (nada entra antes de terminar), arquivo cortado ao meio e arquivo falso (ambos recusados), WebM/VP9 e 4K (convertidos), vídeo novo indo para o fim, arquivo substituído mantendo a posição, vídeo apagado saindo do ciclo, pasta do Drive que some **sem** esvaziar o ciclo, sumiço de todos de uma vez, arquivos temporários ignorados, e a ordem do ciclo (próximo, volta ao início, vídeo adicionado durante a exibição).

### Guardião (`node tools/test-guardian.js`)

Com o app rodando de verdade: queda do processo (reaberto em ~5 s e voltou a tocar), travamento com o processo suspenso (encerrado e reaberto), e saída de propósito (não reabre, o guardião encerra).

### O que NÃO foi testado

- **Num painel de LED / controladora real.** Foi testado só na tela do PC. A saída HDMI, a resolução que a controladora espera e o recorte da imagem precisam ser conferidos no local.
- **Com o aplicativo do Google Drive de verdade.** O Drive não estava instalado no PC de teste; a pasta sincronizada foi simulada com uma pasta local (inclusive upload lento e pasta que some). O comportamento com o cliente real (arquivos temporários, modo streaming) não foi observado.
- **Execução por horas ou dias.** O teste de memória é acelerado (clipes de 2 s), não substitui a observação em campo.
- **O instalador numa máquina limpa** e o **início junto com o Windows**. O instalador (`npm run dist`) foi gerado e a versão empacotada (`dist/win-unpacked`) foi testada com `node tools/test-packaged.js` (ffmpeg embutido, cópia e conversão, exibição, guardião), mas o instalador em si não foi executado, e a opção de abrir com o Windows só age no app instalado.
- Vídeos HDR (não há conversão de tons) e imagens estáticas.

---

## Estrutura do projeto

```
src/main/
  main.js        ciclo de vida, janela do painel, bandeja, IPC, guardião
  ingest.js      o "porteiro": varredura, estabilidade, conferência, conversão
  library.js     biblioteca local e ordem do ciclo (manifest.json)
  media.js       ffprobe / ffmpeg: leitura, conferência de decodificação, conversão
  status.js      STATUS.txt / status.json e CSV de exibições
  guardian.js    processo que reabre o app se ele cair ou travar
  config.js      configuração; logger.js; util.js
src/renderer/    player.* (2 camadas sem corte) e settings.* (janela de configurações)
src/preload/     ponte segura entre as janelas e o processo principal
test/            testes do porteiro e da biblioteca
tools/           measure.js (medição de ponta a ponta), test-guardian.js, test-packaged.js,
                 shot-settings.js (foto da janela de configurações), make-icon.js
```

Decisões de projeto:
- O player **só toca da cópia local**, nunca direto do Drive.
- O porteiro é a única parte que fala com a pasta do Drive, e **só lê** nela.
- Vídeo com erro na exibição é tirado do ciclo e anotado; o painel nunca fica preso nele.
- Ffmpeg e ffprobe vão embutidos (`ffmpeg-static`, `ffprobe-static`): o PC do painel não precisa instalar nada.

---

## Desenvolvimento

Requisitos: Windows e Node.js 22 ou mais novo (testado com a versão 24).

```bash
npm install
npm start            # abre o app (primeira vez: janela de configurações)
npm test             # 21 testes do porteiro e da biblioteca
npm run medir        # medição de ponta a ponta (veja tools/measure.js)
npm run dist         # gera o instalador em dist/
```

Opções de linha de comando (úteis para teste): `--windowed=640x360+40+40` (janela em vez de tela cheia), `--watch=PASTA`, `--giro-data=PASTA` (dados do app em outro lugar), `--no-guardian`, `--cfg=chave=valor`, `--echo` (log no terminal).

Medição:

```bash
node tools/measure.js --seconds=60                 # janela pequena
node tools/measure.js --seconds=60 --fullscreen    # tela cheia (cobre a tela por ~2 min)
node tools/measure.js --soak --seconds=900         # memória durante a exibição
node tools/test-guardian.js
```

---

## Solução de problemas

| Sintoma | O que verificar |
|---|---|
| "Pasta inacessível" | O Google Drive está aberto e conectado? O painel segue tocando a cópia local |
| Vídeo não aparece no ciclo | Veja `STATUS.txt` ou a janela de configurações: pode estar esperando terminar de chegar, na fila de conversão ou **recusado** (motivo anotado) |
| Vídeo recusado | Reenvie o arquivo inteiro. Se continuar, abra-o no computador: se não abre lá, está corrompido |
| Faixas pretas nas laterais | Normal em `fit=contain`. Para preencher a tela use `cover` (corta as bordas) |
| Painel mostra só uma parte da imagem | Ajuste a resolução do Windows para a que a controladora do painel espera |
| Ver o que aconteceu | `%LOCALAPPDATA%\GiroPlay\logs` (botão "Abrir registros" nas configurações) |

---

## Licença

Sem licença de uso definida: todos os direitos reservados ao autor. O código está público para consulta.
