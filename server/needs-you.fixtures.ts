// Fictional copies of the questions one day's fleet asked twice or more: the same
// shapes (ids, values, call timestamps, pedir-natan footers) with invented people.

export interface FixtureQuestion {
  key: string;
  bot: "funil" | "drucker" | "chefe" | "social" | "financeiro" | "suporte";
  thread: string;
  text: string;
  options: string[];
}

export const FUNNEL_DUPLICATES: FixtureQuestion[] = [
  {
    key: "funil-a", bot: "funil", thread: "funil-main",
    text: "Duplicados no funil Vendas (reaberto da caixa de 22/10, ainda sem sua resposta): 4 contatos com 2 negócios cada. Otávio Lemos (negócios 5a1b2c3d e 9e8f7a6b); Bruno Tavares (7c6d5e4f e 3a2b1c0d); Celina Prado (4d5e6f70, Novo lead, e 8a9b0c1d, call marcada 23/10); Ivo Duarte (6f7a8b9c, Pago, e 2c3d4e5f, Novo lead). Hoje confirmei os 4 contatos no CRM; os negócios não reconfirmei pelo ID completo. Não mesclei nada. Mesclar negócio precisa do seu ok. Fonte: crm_list_leads, 22/10 14h.",
    options: ["Mesclar os 4 pares, cada um no negócio com mais histórico (recomendado)", "Não mesclar; só me diga quais são o mesmo caso", "Não mexer em nenhum, eu resolvo pelo app"],
  },
  {
    key: "funil-b", bot: "chefe", thread: "chefe-pedido-1",
    text: "CRM: 4 negócios duplicados e 1 etapa incoerente\n\nMesmo contato em 2 negócios: Otávio Lemos (5a1b2c3d e 9e8f7a6b), Bruno Tavares (7c6d5e4f e 3a2b1c0d), Celina Prado (4d5e6f70 Novo lead e 8a9b0c1d Call marcada 23/10), Ivo Duarte (6f7a8b9c Pago e 2c3d4e5f Novo lead). Nada mesclado nem apagado. Fonte: crm_list_leads, funil Vendas, 22/10 14h; não reconfirmado hoje.\n\n— de Funil (Brunson), caixa_natan id 6 (funil-duplicados-2026-10-22) · 14:18 · pedido c27da3f1",
    options: ["Mesclar cada par, mantendo o negócio mais avançado (Recomendada)", "Mesclar só Otávio Lemos e Bruno Tavares", "Não mesclar nada agora"],
  },
  {
    key: "funil-c", bot: "funil", thread: "funil-task",
    text: "Natan, decisão sobre os 4 pares duplicados do funil Vendas. Recomendo: mesclar Otávio, Bruno e Celina mantendo o negócio mais avançado, e tirar o Ivo da Vendas (ele é cliente com plano; o upsell vai para a Renovação do Hormozi). Confirma?",
    options: ["Sim: mesclar Otávio, Bruno e Celina; Ivo para Renovação", "Só entender o motivo antes; não mesclar ainda", "Não mexer nesses 4"],
  },
];

export const STALLED_PROPOSAL: FixtureQuestion[] = [
  {
    key: "proposta-a", bot: "funil", thread: "funil-main",
    text: "Paulo Henrique: proposta de R$ 4.000 parada desde julho (negócio 5c0d71a9, em Proposta, reunião 30/06, sem próximo passo). Última mensagem nossa: 23/07/2026, no 7731, sem tag rota-vendas nem vendas-bot; então SDR e Closer não o tocam. O contato também tem a tag downsell-vagas-enviado (não sei quando). Para onde vai?",
    options: ["Closer (Cardone), com rota-vendas (recomendado)", "Nutrição, sem cobrança agora", "Deixar como está"],
  },
  {
    key: "proposta-b", bot: "chefe", thread: "chefe-pedido-2",
    text: "Paulo Henrique: proposta de R$ 4.000 parada desde julho\n\nNegócio 5c0d71a9 em Proposta, reunião 30/06, sem próximo passo. Última mensagem nossa: 23/07/2026, no 7731 (conversa 1f2e3d4c), sem tag rota-vendas nem vendas-bot, então SDR e Closer não tocam. Fonte: crm_get_lead e crm_list_conversations, 22/10 14h; não reconfirmado hoje.\n\n— de Funil (Brunson), caixa_natan id 7 (funil-paulo-henrique-proposta-2026-10-22) · 14:18 · pedido 388610c8",
    options: ["Mandar para o Closer (Caio) com rota-vendas (Recomendada)", "Mandar para Nutrição", "Deixar como está"],
  },
];

/** Four different subjects one bot asked in one conversation, three of them also asked again through pedir-natan. */
export const MEETING_QUESTIONS: FixtureQuestion[] = [
  {
    key: "desconto", bot: "drucker", thread: "drucker-call",
    text: "Anselmo (gerente da Torre Alta, Plano Pro) volta amanhã, 24/10, para fechar. Ele pediu preço melhor: 12x R$1.200 ou R$12.000 à vista, mais 1 reunião individual extra por mês. Não fechou hoje. Você decide o desconto e a reunião extra. Fonte: call 100000001, 23/10. Trechos: desconto 02:02:41 ('Eu só atendo corretor'); reunião extra 02:03:27. Também pendentes na mesma call: integração C2S (00:23:16) e bônus por desempenho (00:36:07). Palpite meu: manter o preço e oferecer só a reunião extra. O Cardone (Closer) faz o retorno e a proposta depois da sua decisão.",
    options: ["Sem desconto, com reunião extra mensal (recomendado)", "Dar desconto e manter a reunião extra", "Sem desconto e sem reunião extra", "Adiar: decido amanhã cedo antes do retorno"],
  },
  {
    key: "promessas", bot: "drucker", thread: "drucker-call",
    text: "Antes da proposta sair para o Rafael (lead Plano Pro, decide até 29/10; o Caio manda a proposta), confirme duas promessas que você fez na call de 22/10: (1) token de IA ilimitado por 12 meses (subsídio Anthropic) e CRM sem limite de corretores, leads ou WhatsApp [00:47:01–00:47:12]; (2) o OS agenda sozinho o follow-up de 29/10 [00:59:21–00:59:37]. Não verifiquei: nos meus registros a regra do Mentor IA é 100 msgs/mês, o que contradiz 'ilimitado'; e o 'garanto 12 meses' não está no OFERTA. Palpite meu: corrigir antes de sair.",
    options: ["Corrigir antes de sair (recomendado)", "Confirmo as duas como estão", "Tiro só o token ilimitado", "Tiro só o agendamento automático"],
  },
  {
    key: "cadastro", bot: "drucker", thread: "drucker-call",
    text: "A Juliana (OS) pediu cadastro de imóvel por PDF, planilha da incorporação ou modelo Excel, com várias unidades por empreendimento [00:18:54–00:19:08]. Você disse que deixa o cadastro com IA ilimitado por enquanto, com cadastro manual junto, e limita se der problema [00:20:50–00:21:29]. Fonte: call 100000002, 22/10. Falta sua decisão: manter ilimitado ou pôr limite já.",
    options: ["Manter ilimitado; limitar se der problema (recomendado, é o que você disse)", "Pôr limite já"],
  },
  {
    key: "prazo", bot: "drucker", thread: "drucker-call",
    text: "A Juliana perguntou quando saem radar de anúncios, publicação e site próprio, que ainda não aparecem [00:21:46–00:22:41]. Você disse 'vai sair', talvez liberar depois de cadastrar imóvel, e nenhum prazo foi dito. Fonte: call 100000002, 22/10. Decida: dar prazo ou deixar sem data. Palpite meu: sem data por ora, para não prometer o que não está verificado.",
    options: ["Sem data por ora (recomendado)", "Dar prazo: eu informo a data", "Liberar junto com o cadastro por PDF"],
  },
  {
    key: "desconto-pedido", bot: "chefe", thread: "chefe-pedido-3",
    text: "Anselmo (Plano Pro): libera desconto ou bônus além da proposta?\n\nEle volta amanhã (24/10) de manhã. A proposta foi enviada às 13h32: 12x R$1.200 ou R$12.000 à vista, mais 1 reunião individual por mês, sem desconto extra. Ele pediu preço melhor [02:02:23–02:02:47]. Outros pontos que ficaram em aberto na call: integração com C2S [00:23:16] e bônus por desempenho [00:36:07]. Quem libera é você. Nota: em alguns trechos o Fathom troca as falas suas e do Anselmo; confira na gravação. Fonte: call 100000001.\n\n— de Drucker · 14:20 · pedido 64eff31e",
    options: ["Manter a proposta como está (Recomendada)", "Liberar desconto (você define o valor)", "Liberar bônus (reunião extra, C2S ou desempenho)"],
  },
  {
    key: "promessas-pedido", bot: "chefe", thread: "chefe-pedido-4",
    text: "Rafael (Plano Pro 22/10): as promessas da proposta valem?\n\nNa call você disse que o token de IA é ilimitado por 12 meses (subsídio Anthropic) e que o CRM não tem limite de corretores, leads ou WhatsApp [00:47:01–00:47:12]. Disse também que o OS agenda sozinho o follow-up de 29/10 [00:59:21–00:59:37]. A proposta saiu em 22/10 às 15h11, com a gravação. Ele decide até 29/10. Confira na gravação antes de responder: o Fathom troca falas em alguns trechos. Fonte: call 100000003.\n\n— de Drucker · 14:20 · pedido 7603cfea",
    options: ["Conferir na gravação antes de responder (Recomendada)", "Confirmo: as duas promessas valem", "Não valem: corrijo com o Rafael"],
  },
  {
    key: "cadastro-pedido", bot: "chefe", thread: "chefe-pedido-5",
    text: "Cadastro por PDF e planilha: IA ilimitada ou com limite?\n\nA Juliana pediu cadastro por PDF, planilha da incorporação ou modelo Excel, com várias unidades por empreendimento [00:18:54–00:19:08]. Na call de 22/10 (100000002) você disse que deixa o cadastro com IA ilimitado por enquanto e limita se der problema, com cadastro manual junto [00:20:50–00:21:29]. Virou pedido de recurso. Essa decisão está pendente desde 22/10.\n\n— de Drucker · 14:20 · pedido 249798fb",
    options: ["Manter ilimitado por enquanto (Recomendada)", "Pôr limite agora (você define o número)", "Liberar só com revisão humana"],
  },
];

/** Unrelated questions of the same weeks, so rare and common words weigh as they do on a real install. */
export const OTHER_QUESTIONS: FixtureQuestion[] = [
  ["social", "O carrossel sobre quantos criativos testar por mês está com os slides 1 a 9 prontos e travou no slide 10. Uso a arte nova do webinar ou só texto?", ["Arte nova do webinar", "Só texto", "Adiar o post"]],
  ["financeiro", "Um Pix de R$ 310,40 para uma fintech em 26/09 parece pagamento de fatura de um cartão que não está no controle financeiro. O cartão é seu?", ["É meu: traga as compras", "É da empresa", "Ignorar"]],
  ["suporte", "O portal Casa Nova só ativa a integração quando um cliente nosso que também usa o portal pede. Qual cliente em comum uso para pedir?", ["Te passo o cliente", "Escolha você", "Não pedir agora"]],
  ["suporte", "Minha volta diária de testes não rodou porque o único Chrome do computador é o seu. Crio um perfil isolado só para mim?", ["Criar perfil isolado", "Usar o seu navegador", "Pular os testes"]],
  ["suporte", "A aluna da mentoria respondeu ao check-in com um áudio e ninguém transcreveu. Quem ouve o áudio?", ["Eu ouço e te digo", "Transcreva você", "Responder sem ouvir"]],
  ["social", "O perfil novo quase não foi visto: alcance 5 no primeiro post e 13 visualizações no segundo. Impulsiono ou troco o lote por Reels?", ["Só orgânico com Reels", "Impulsionar com verba pequena", "Pausar o perfil"]],
  ["funil", "A agenda da call estratégica não tem horário livre e a abordagem ativa parou. Abro mais horários?", ["Ampliar seg a sex", "Ampliar só 7 dias", "Manter"]],
  ["social", "O Closer pediu prova com número para a objeção sem caixa e nenhuma prova do acervo tem autorização. Peço autorização aos três alunos?", ["Pedir aos 3", "Pedir a dois", "Não pedir"]],
  ["suporte", "O convite do portal de chamados pede criar uma senha numa página interativa. Faço isso por você?", ["Pule, o chamado basta", "Abra e eu defino", "Faça você"]],
  ["chefe", "Proponho uma regra para a frota: pergunta pendente nunca expira e volta no resumo da manhã. Aplico?", ["Sim, aplicar", "Não"]],
  ["chefe", "O importador do parceiro de lançamentos pede reunião, mas ainda não deu o token do sandbox. Construímos agora?", ["Não construir agora", "Construir já"]],
  ["chefe", "Qual horário aprovar para postar no perfil pessoal? O bot só publica com horário aprovado.", ["Aguardar", "Informar dia e hora"]],
  ["funil", "A rotina do placar das 18h está pausada e sem ela o placar não entra na lista das 8h. Gravo o placar na rodada das 13h50?", ["Sim, gravar", "Não"]],
  ["funil", "Criei por engano uma tarefa de downsell no negócio de um cliente do grupo quente. Apago a tarefa?", ["Apagar", "Manter"]],
  ["funil", "O lote de downsell travou: 31 dos 58 itens da fila esperam aprovação de envio no número 6019. Abro o envio?", ["Sim, abrir", "Esperar"]],
  ["financeiro", "A assinatura da ferramenta de vídeo renova amanhã por R$ 980 no plano anual. Renovo ou passo para o mensal?", ["Renovar anual", "Passar para mensal", "Cancelar"]],
  ["suporte", "Três clientes pediram exportar relatório em planilha e o recurso não existe. Abro pedido de recurso para o time do produto?", ["Abrir pedido", "Responder que não há", "Esperar mais pedidos"]],
  ["social", "O vídeo de bastidores tem música com direito autoral. Troco a trilha ou publico sem som?", ["Trocar a trilha", "Sem som", "Não publicar"]],
  ["chefe", "A reunião semanal de quinta conflita com a call do parceiro. Movo a reunião para sexta às 10h?", ["Mover para sexta", "Manter quinta"]],
  ["financeiro", "O fornecedor de hospedagem cobrou duas vezes em outubro. Peço estorno ou crédito na próxima fatura?", ["Pedir estorno", "Aceitar crédito"]],
  ["suporte", "Um cliente pediu cancelamento dentro dos 7 dias de garantia. Devolvo o valor integral?", ["Devolver integral", "Oferecer troca de plano"]],
  ["social", "A campanha de indicação terminou com 42 cadastros. Repito no mês que vem com o mesmo prêmio?", ["Repetir igual", "Trocar o prêmio", "Não repetir"]],
  ["funil", "Um lead quente pediu condição especial para pagar no boleto em 6 vezes. Libero?", ["Liberar", "Só cartão", "Perguntar ao financeiro"]],
  ["chefe", "O backup semanal da base falhou duas vezes por falta de espaço no disco. Amplio o disco em 50 GB?", ["Ampliar", "Limpar arquivos velhos"]],
  ["suporte", "O manual de boas-vindas está desatualizado desde a troca do painel. Reescrevo agora ou depois do lançamento?", ["Agora", "Depois do lançamento"]],
].map(([bot, text, options], index) => ({ key: `outra-${index}`, bot: bot as FixtureQuestion["bot"], thread: `${bot}-outra-${index}`, text: text as string, options: options as string[] }));
