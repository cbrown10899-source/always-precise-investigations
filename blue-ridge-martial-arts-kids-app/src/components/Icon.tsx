import {
  Activity, BookOpen, Calendar, CheckCircle2, Clock, Flame, Footprints, Hand,
  Heart, Layers, Lightbulb, Medal, Moon, Mountain, MoveVertical, PersonStanding,
  Play, Repeat, Scale, Shield, Smile, Sparkles, Star, Sunrise, Target, Trophy,
  type LucideIcon,
} from 'lucide-react'
import type { IconKey } from '../types'

/**
 * The icon registry.
 *
 * Data files name an icon by KEY, never by component, so `src/data/` stays
 * free of React imports and could be replaced by an API response without
 * change. This map is the only place a key becomes a component.
 */
const REGISTRY: Record<IconKey, LucideIcon> = {
  stance: PersonStanding,
  guard: Shield,
  punch: Hand,
  kick: Activity,
  footwork: Footprints,
  balance: Scale,
  focus: Target,
  etiquette: Medal,
  flexibility: MoveVertical,
  warmup: Sunrise,
  demo: Play,
  learn: BookOpen,
  reps: Repeat,
  check: Lightbulb,
  complete: CheckCircle2,
  cooldown: Moon,
  mountain: Mountain,
  trophy: Trophy,
  star: Star,
  flame: Flame,
  calendar: Calendar,
  clock: Clock,
  belt: Layers,
  shield: Shield,
  heart: Heart,
  smile: Smile,
  target: Target,
  sparkle: Sparkles,
}

interface IconProps {
  name: IconKey
  size?: number
  strokeWidth?: number
  className?: string
}

/**
 * Icons are decoration beside a label everywhere in this app, so they are
 * hidden from assistive technology. Where an icon is the ONLY content of a
 * control, that control carries its own `aria-label`.
 */
export function Icon({ name, size = 20, strokeWidth = 2, className }: IconProps) {
  const Component = REGISTRY[name] ?? Sparkles
  return (
    <Component size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  )
}
