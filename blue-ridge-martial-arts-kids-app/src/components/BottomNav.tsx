import { NavLink } from 'react-router-dom'
import { Activity, BarChart3, BookOpen, Home, MoreHorizontal } from 'lucide-react'

/**
 * The five-destination bottom navigation.
 *
 * `NavLink` sets `aria-current="page"` on the active item, and the active item
 * also carries a bar above it — completion and state are never signalled by
 * colour alone anywhere in this app.
 */
const ITEMS = [
  { to: '/', label: 'Home', Icon: Home, end: true },
  { to: '/lessons', label: 'Lessons', Icon: BookOpen, end: false },
  { to: '/practice', label: 'Practice', Icon: Activity, end: false },
  { to: '/progress', label: 'Progress', Icon: BarChart3, end: false },
  { to: '/more', label: 'More', Icon: MoreHorizontal, end: false },
]

export function BottomNav() {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__inner">
        {ITEMS.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="nav__btn">
            <Icon size={21} strokeWidth={2} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
