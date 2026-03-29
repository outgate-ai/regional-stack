import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

export const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
});

export const ProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  provider: z.string().min(1),
  createdAt: z.date(),
});

export const CreateProviderSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  logRequestBody: z.boolean().optional().default(false),
  logResponseBody: z.boolean().optional().default(false),
});

export const ApiTokenSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string().min(1),
  tokenHash: z.string().optional(),
  token: z.string().optional(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable().optional(),
  isActive: z.boolean(),
});

export const CreateApiTokenSchema = z.object({
  name: z.string().min(1),
});

export const LogEntrySchema = z.object({
  id: z.string().optional(),
  timestamp: z.date().optional(),
  userId: z.string(),
  level: z.enum(['info', 'warn', 'error', 'debug']),
  source: z.string().optional(),
  message: z.string(),
  meta: z.record(z.any()).optional(),
});

export const LogQuerySchema = z.object({
  userId: z.string().optional(),
  level: z.enum(['info', 'warn', 'error', 'debug']).optional(),
  limit: z.number().min(1).max(1000).default(100),
  since: z.string().optional(),
});

export const AssignProviderSchema = z.object({
  limits: z.record(z.any()).optional(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>;
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenSchema>;
export type LogEntryInput = z.infer<typeof LogEntrySchema>;
export type LogQueryInput = z.infer<typeof LogQuerySchema>;
export type AssignProviderInput = z.infer<typeof AssignProviderSchema>;
