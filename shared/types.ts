// Scene graph: the canvas is a pure view of this JSON. Layers are ordered bottom -> top.

export type LayerRole =
  | 'background'
  | 'photo'
  | 'illustration'
  | 'decoration'
  | 'card'
  | 'headline'
  | 'subheadline'
  | 'body'
  | 'offer'
  | 'cta'
  | 'logo'
  | 'disclaimer'
  | 'other';

interface LayerBase {
  id: string;
  name: string;
  role?: LayerRole;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  fill: string;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  uppercase?: boolean;
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: 'rect' | 'ellipse';
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
  /** Optional centred label, used for CTA pills and badges. */
  label?: string;
  labelColor?: string;
  labelFontFamily?: string;
  labelFontSize?: number;
  labelFontWeight?: number;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  src: string;
  /** Set when the image comes from the brand asset library. */
  assetId?: string;
  /** Set when the image was produced by the image model. */
  prompt?: string;
  fit?: 'cover' | 'contain';
  cornerRadius?: number;
  pending?: boolean;
}

export type Layer = TextLayer | ShapeLayer | ImageLayer;

export interface Scene {
  id: string;
  format: string;
  width: number;
  height: number;
  background: string;
  layers: Layer[];
}

export interface FormatPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { id: 'post', label: 'Instagram post 1:1', width: 1080, height: 1080 },
  { id: 'portrait', label: 'Portrait post 4:5', width: 1080, height: 1350 },
  { id: 'story', label: 'Story 9:16', width: 1080, height: 1920 },
  { id: 'banner', label: 'Banner 1.91:1', width: 1200, height: 628 },
];

// Brand kit

export type AssetCategory =
  | 'logo'
  | 'shape'
  | 'icon'
  | 'illustration'
  | 'background_template'
  | 'product_photo'
  | 'photo'
  | 'guideline_page'
  | 'reference'
  | 'font'
  | 'other';

export const ASSET_CATEGORIES: AssetCategory[] = [
  'logo',
  'shape',
  'icon',
  'illustration',
  'background_template',
  'product_photo',
  'photo',
  'guideline_page',
  'reference',
  'font',
  'other',
];

export interface Asset {
  id: string;
  filename: string;
  folder?: string;
  url: string;
  thumbUrl?: string;
  mime: string;
  width?: number;
  height?: number;
  category: AssetCategory;
  description?: string;
  colors?: string[];
  /** Background templates and shapes: GRID_SIZE x GRID_SIZE row-major colours of the image stretched to a square, '' where transparent. */
  grid?: string[];
  tags?: string[];
}

export const GRID_SIZE = 16;

export interface PaletteColor {
  name: string;
  hex: string;
  role?: string;
}

export interface BrandFont {
  family: string;
  weight?: number;
  source: 'google' | 'upload' | 'system';
  url?: string;
  note?: string;
}

export interface LogoRule {
  assetId: string;
  variant: string;
  useOn: string;
}

export interface BrandProfile {
  name: string;
  palette: PaletteColor[];
  fonts: { headline: BrandFont; body: BrandFont };
  logos: LogoRule[];
  rules: string[];
  tone?: string;
  safeZones?: { format: string; top: number; bottom: number; left: number; right: number }[];
}

export interface BrandKit {
  profile: BrandProfile | null;
  assets: Asset[];
  templates?: LayoutTemplate[];
  /** House style of the brand's photography and illustration, written from its own images; steers the image model. */
  imageStyle?: { photo?: string; illustration?: string };
  status: 'empty' | 'ingesting' | 'ready' | 'error';
  progress?: string;
}

// Layout templates (archetypes extracted from reference ads)

export type FrameKey = '1:1' | '4:5' | '9:16';
export const FRAME_KEYS: FrameKey[] = ['1:1', '4:5', '9:16'];

export type SlotKind =
  | 'card'
  | 'shape'
  | 'decoration'
  | 'photo'
  | 'product_photo'
  | 'illustration'
  | 'icon'
  | 'text'
  | 'cta'
  | 'logo';

export interface TemplateSlot {
  id: string;
  kind: SlotKind;
  role: LayerRole;
  /** Fractions of the canvas [x, y, width, height] per aspect ratio. */
  frames: Record<FrameKey, [number, number, number, number]>;
  color?: string;
  /** Font size as a fraction of canvas width (text slots). */
  fontSizeRatio?: number;
  fontWeight?: number;
  align?: 'left' | 'center' | 'right';
  /** Corner radius as a fraction of canvas width (cards). */
  cornerRadiusRatio?: number;
  example?: string;
  maxWords?: number;
  notes?: string;
}

export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  background: { color?: string; useTemplateAsset?: boolean };
  slots: TemplateSlot[];
  sourceAssetIds: string[];
}

// Brand linter

export type LintRule = 'palette' | 'font' | 'logo' | 'contrast' | 'safe_zone' | 'bounds' | 'legibility' | 'layout';

export interface LintIssue {
  id: string;
  rule: LintRule;
  severity: 'error' | 'warning';
  layerId?: string;
  message: string;
  /** Deterministic repair; applied by auto-fix. */
  fix?: { layerId: string; patch: Record<string, unknown> } | { background: string };
}

// Agent streaming events (server -> client, NDJSON)

export type AgentEvent =
  | { type: 'step'; text: string; variant?: number }
  | { type: 'review'; score: number; verdict: string; variant?: number }
  | { type: 'scene'; scene: Scene; label?: string; variant?: number }
  | { type: 'message'; text: string; variant?: number }
  | { type: 'variants_start'; count: number; scenes: Scene[] }
  | { type: 'error'; text: string; variant?: number }
  | { type: 'done'; variant?: number };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
