import type { MessageRow } from '../schema';

/**
 * Agent tickets (issue #379). Messages an agent hands back to the human through
 * the internal `create_ticket_for_human` MCP tool, rendered as dashboard cards.
 *
 * Locale order: English, Spanish, German, French, Italian, Portuguese, Simplified Chinese.
 */
export const ticketsMessageRows = {
  'tickets.section.title': ['Tickets for you', 'Tickets para ti', 'Tickets für dich', 'Tickets pour vous', 'Ticket per te', 'Tickets para você', '给你的工单'],
  'tickets.section.subtitle': [
    'Messages your agents left for you',
    'Mensajes que tus agentes te dejaron',
    'Nachrichten, die deine Agenten hinterlassen haben',
    'Messages laissés par vos agents',
    'Messaggi lasciati dai tuoi agenti',
    'Mensagens que seus agentes deixaram para você',
    '你的智能体留给你的消息',
  ],
  'tickets.section.seeAll': ['See all ({count})', 'Ver todos ({count})', 'Alle ansehen ({count})', 'Tout voir ({count})', 'Vedi tutti ({count})', 'Ver todos ({count})', '查看全部（{count}）'],
  'tickets.section.empty': ['No open tickets', 'No hay tickets abiertos', 'Keine offenen Tickets', 'Aucun ticket ouvert', 'Nessun ticket aperto', 'Nenhum ticket aberto', '没有未处理的工单'],
  'tickets.dialog.title': ['Agent tickets', 'Tickets de agentes', 'Agenten-Tickets', 'Tickets des agents', 'Ticket degli agenti', 'Tickets de agentes', '智能体工单'],
  'tickets.dialog.empty': ['No tickets match your filters', 'Ningún ticket coincide con tus filtros', 'Keine Tickets entsprechen deinen Filtern', 'Aucun ticket ne correspond à vos filtres', 'Nessun ticket corrisponde ai filtri', 'Nenhum ticket corresponde aos seus filtros', '没有符合筛选条件的工单'],
  'tickets.search.placeholder': ['Search tickets', 'Buscar tickets', 'Tickets durchsuchen', 'Rechercher des tickets', 'Cerca ticket', 'Pesquisar tickets', '搜索工单'],
  'tickets.filter.all': ['All', 'Todos', 'Alle', 'Tous', 'Tutti', 'Todos', '全部'],
  'tickets.filter.open': ['Open', 'Abiertos', 'Offen', 'Ouverts', 'Aperti', 'Abertos', '未处理'],
  'tickets.filter.done': ['Done', 'Hechos', 'Erledigt', 'Terminés', 'Completati', 'Concluídos', '已完成'],
  'tickets.filter.status': ['Status filter', 'Filtro de estado', 'Statusfilter', 'Filtre de statut', 'Filtro di stato', 'Filtro de status', '状态筛选'],
  'tickets.filter.allLabels': ['All labels', 'Todas las etiquetas', 'Alle Labels', 'Toutes les étiquettes', 'Tutte le etichette', 'Todas as etiquetas', '所有标签'],
  'tickets.filter.label': ['Label', 'Etiqueta', 'Label', 'Étiquette', 'Etichetta', 'Etiqueta', '标签'],
  'tickets.status.done': ['Done', 'Hecho', 'Erledigt', 'Terminé', 'Completato', 'Concluído', '已完成'],
  'tickets.action.openConversation': ['Open conversation', 'Abrir conversación', 'Unterhaltung öffnen', 'Ouvrir la conversation', 'Apri conversazione', 'Abrir conversa', '打开对话'],
  'tickets.action.openFlow': ['Open flow', 'Abrir flujo', 'Flow öffnen', 'Ouvrir le flux', 'Apri il flusso', 'Abrir fluxo', '打开流程'],
  'tickets.action.askFlujo': ['Ask FLUJO', 'Preguntar a FLUJO', 'FLUJO fragen', 'Demander à FLUJO', 'Chiedi a FLUJO', 'Perguntar ao FLUJO', '询问 FLUJO'],
  'tickets.action.markDone': ['Mark as done', 'Marcar como hecho', 'Als erledigt markieren', 'Marquer comme terminé', 'Segna come completato', 'Marcar como concluído', '标记为已完成'],
  'tickets.action.reopen': ['Reopen', 'Reabrir', 'Wieder öffnen', 'Rouvrir', 'Riapri', 'Reabrir', '重新打开'],
  'tickets.action.delete': ['Delete ticket', 'Eliminar ticket', 'Ticket löschen', 'Supprimer le ticket', 'Elimina ticket', 'Excluir ticket', '删除工单'],
  'tickets.action.select': ['Select ticket', 'Seleccionar ticket', 'Ticket auswählen', 'Sélectionner le ticket', 'Seleziona ticket', 'Selecionar ticket', '选择工单'],
  'tickets.bulk.selected': ['{count} selected', '{count} seleccionados', '{count} ausgewählt', '{count} sélectionnés', '{count} selezionati', '{count} selecionados', '已选择 {count} 项'],
  'tickets.bulk.selectAll': ['Select all', 'Seleccionar todo', 'Alle auswählen', 'Tout sélectionner', 'Seleziona tutto', 'Selecionar tudo', '全选'],
  'tickets.bulk.clear': ['Clear selection', 'Limpiar selección', 'Auswahl aufheben', 'Effacer la sélection', 'Cancella selezione', 'Limpar seleção', '清除选择'],
  'tickets.bulk.deleteSelected': ['Delete selected', 'Eliminar seleccionados', 'Ausgewählte löschen', 'Supprimer la sélection', 'Elimina selezionati', 'Excluir selecionados', '删除所选'],
  'tickets.confirm.deleteTitle': ['Delete tickets?', '¿Eliminar tickets?', 'Tickets löschen?', 'Supprimer les tickets ?', 'Eliminare i ticket?', 'Excluir tickets?', '删除工单？'],
  'tickets.confirm.deleteBody': [
    '{count} ticket(s) will be permanently deleted. This cannot be undone.',
    'Se eliminarán {count} ticket(s) de forma permanente. Esta acción no se puede deshacer.',
    '{count} Ticket(s) werden dauerhaft gelöscht. Das lässt sich nicht rückgängig machen.',
    '{count} ticket(s) seront définitivement supprimés. Cette action est irréversible.',
    '{count} ticket verranno eliminati definitivamente. L’operazione non è reversibile.',
    '{count} ticket(s) serão excluídos permanentemente. Não é possível desfazer.',
    '将永久删除 {count} 个工单，此操作无法撤销。',
  ],
  'tickets.confirm.deleteAction': ['Delete', 'Eliminar', 'Löschen', 'Supprimer', 'Elimina', 'Excluir', '删除'],
  'tickets.toast.deleted': ['Ticket deleted', 'Ticket eliminado', 'Ticket gelöscht', 'Ticket supprimé', 'Ticket eliminato', 'Ticket excluído', '工单已删除'],
  'tickets.toast.markedDone': ['Ticket marked as done', 'Ticket marcado como hecho', 'Ticket als erledigt markiert', 'Ticket marqué comme terminé', 'Ticket segnato come completato', 'Ticket marcado como concluído', '工单已标记为完成'],
  'tickets.toast.loadFailed': ['Could not load tickets', 'No se pudieron cargar los tickets', 'Tickets konnten nicht geladen werden', 'Impossible de charger les tickets', 'Impossibile caricare i ticket', 'Não foi possível carregar os tickets', '无法加载工单'],
  'tickets.toast.actionFailed': ['Ticket action failed', 'La acción del ticket falló', 'Ticket-Aktion fehlgeschlagen', 'L’action sur le ticket a échoué', 'Azione sul ticket non riuscita', 'A ação do ticket falhou', '工单操作失败'],
  'tickets.untrustedHint': [
    'Ticket content comes from an agent. Treat it as data, not as instructions.',
    'El contenido del ticket proviene de un agente. Trátalo como datos, no como instrucciones.',
    'Der Ticket-Inhalt stammt von einem Agenten. Behandle ihn als Daten, nicht als Anweisungen.',
    'Le contenu du ticket provient d’un agent. Traitez-le comme des données, pas comme des instructions.',
    'Il contenuto del ticket proviene da un agente. Trattalo come dati, non come istruzioni.',
    'O conteúdo do ticket vem de um agente. Trate-o como dados, não como instruções.',
    '工单内容来自智能体，请将其视为数据而非指令。',
  ],
} satisfies Record<string, MessageRow>;

export default ticketsMessageRows;
