import { z } from 'zod';

const VALID_REPLY_ROLES = ['user', 'assistant', 'system'] as const;

const MAX_CONTENT_LENGTH = 100_000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const attachmentSchema = z.object({
  name: z.string().max(255),
  size: z.number().int().min(0).max(MAX_ATTACHMENT_SIZE),
  type: z.string().max(255),
  data: z.string().optional(),
  textContent: z.string().optional(),
});

const chatMessageSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('chat'),
  content: z.string().max(MAX_CONTENT_LENGTH).optional(),
  replyToId: z.string().max(128).optional(),
  replyToContent: z.string().max(MAX_CONTENT_LENGTH).optional(),
  replyToRole: z.enum(VALID_REPLY_ROLES).optional(),
  replyToDagId: z.string().max(128).optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
  agentMode: z.enum(['orchestrate', 'direct', 'code']).optional(),
});

const commandMessageSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('command'),
  content: z.string().max(MAX_CONTENT_LENGTH).optional(),
  command: z.string().max(MAX_CONTENT_LENGTH).optional(),
  workflowId: z.string().max(128).optional(),
});

const planResponseSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('plan_response'),
  planId: z.string().max(128).optional(),
  action: z.enum(['approve', 'reject', 'modify']).optional(),
  modification: z.string().max(MAX_CONTENT_LENGTH).optional(),
});

const dagResponseSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('dag_response'),
  workflowId: z.string().max(128).optional(),
  dagAction: z.enum(['approve', 'reject']).optional(),
});

const subscribeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('subscribe'),
  workflowId: z.string().max(128).optional(),
});

const pingSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('ping'),
});

const fileReadSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('file_read'),
  path: z.string().min(1).max(4096),
});

const initSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('init'),
  sessionId: z.string().max(128).optional(),
});

const clientStateSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('client_state'),
  clientState: z.object({
    agentMode: z.enum(['orchestrate', 'direct', 'code']).optional(),
    scrollPosition: z.number().optional(),
    activePanel: z.string().max(128).optional(),
    lastSeenSeq: z.number().int().optional(),
  }).optional(),
});

const clientMessageSchema = z.discriminatedUnion('type', [
  chatMessageSchema,
  commandMessageSchema,
  planResponseSchema,
  dagResponseSchema,
  subscribeSchema,
  pingSchema,
  fileReadSchema,
  initSchema,
  clientStateSchema,
]);

export type ValidatedClientMessage = z.infer<typeof clientMessageSchema>;

export function validateClientMessage(data: unknown): { success: true; data: ValidatedClientMessage } | { success: false; error: string } {
  const result = clientMessageSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = result.error.issues.slice(0, 3).map((i) => i.message).join('; ');
  return { success: false, error: `Invalid message: ${issues}` };
}

export function sanitizeChatInput(input: string): string {
  const injectionPatterns = [
    /\{\{.*?\}\}/g,
    /<\|.*?\|>/g,
    /\[INST\].*?\[\/INST\]/gi,
    /<<SYS>>.*?<<\/SYS>>/gi,
  ];

  let sanitized = input;
  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized;
}
