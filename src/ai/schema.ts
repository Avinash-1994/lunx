import { z } from '../lib/schema.js';

export const ProjectProfileSchema = z.object({
    framework: z.string().optional(),
    cssFramework: z.string().optional(),
    language: z.enum(['typescript', 'javascript']).optional(),
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'bun']).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    configSummary: z.record(z.string(), z.any()).optional(),
    size: z.object({
        totalJs: z.number().optional(),
        vendorChunk: z.number().optional(),
    }).optional(),
    entries: z.array(z.string()).optional(),
    cache: z.object({
        hitRate: z.number().optional(),
    }).optional(),
    warnings: z.array(z.string()).optional(),
});

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export const BuildSessionSchema = z.object({
    id: z.string(),
    timestamp: z.number(),
    duration: z.number(),
    success: z.boolean(),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    metrics: z.object({
        modules: z.number().optional(),
        bundleSize: z.number().optional(),
        cacheHits: z.number().optional(),
    }).optional(),
});

export type BuildSession = z.infer<typeof BuildSessionSchema>;

export const AIRequestSchema = z.object({
    type: z.enum(['fix', 'optimize', 'report', 'chat']),
    context: z.object({
        project: ProjectProfileSchema.optional(),
        session: BuildSessionSchema.optional(),
        files: z.record(z.string(), z.string()).optional(), // filename -> content snippet
        query: z.string().optional(),
    }),
    preferences: z.object({
        model: z.enum(['cloud', 'local']).default('cloud'),
        privacy: z.enum(['high', 'low']).default('high'),
    }).optional(),
});

export type AIRequest = z.infer<typeof AIRequestSchema>;
