import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(here, '../data'),
  pro: {
    baseURL: required('DEEPSEEK_PRO_BASE_URL'),
    apiKey: required('DEEPSEEK_PRO_API_KEY'),
    model: process.env.DEEPSEEK_PRO_MODEL ?? 'DeepSeek-V4-Pro',
  },
  flash: {
    baseURL: required('DEEPSEEK_FLASH_BASE_URL'),
    apiKey: required('DEEPSEEK_FLASH_API_KEY'),
    model: process.env.DEEPSEEK_FLASH_MODEL ?? 'DeepSeek-V4.1-Flash',
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    visionModel: process.env.VISION_MODEL ?? 'gpt-4.1-mini',
    visionModelStrong: process.env.VISION_MODEL_STRONG ?? 'gpt-4.1',
    imageModel: process.env.IMAGE_MODEL ?? 'gpt-image-1-mini',
    imageQuality: (process.env.IMAGE_QUALITY ?? 'medium') as 'low' | 'medium' | 'high',
  },
};
