export const ROUTINE_NO_UPDATE_TOOL = {
  name: "routine_no_update",
  description: "Routine or webhook runs only: call when this run found nothing the person needs to see, then end your turn without text. The run keeps its receipt but marks nothing unread and sends no notification. Failures, questions and approvals still reach the person.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};
