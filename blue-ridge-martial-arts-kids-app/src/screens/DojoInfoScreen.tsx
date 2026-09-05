import { AlertCircle, Globe, Mail, MapPin, Phone, User } from 'lucide-react'
import { SubHeader } from '../components/SubHeader'
import { MountainRidge } from '../components/MountainRidge'
import { Card, CardHead, Chip, Note } from '../components/ui'
import { useApp } from '../hooks/useApp'
import { formatTimeRange } from '../utils/dates'
import { DAY_NAMES } from '../utils/dates'

/**
 * The school card.
 *
 * Every contact detail is NULL in the seeded data, because the app has not
 * been given Blue Ridge Martial Arts' real phone number, address, website or
 * instructor names. A missing field says "Add school contact information"
 * rather than showing a plausible placeholder that somebody might dial. There
 * is a test asserting none of these fields carries an invented value.
 */
export function DojoInfoScreen() {
  const { state } = useApp()
  const dojo = state.dojo
  const cls = state.instructor.classSession

  const fields = [
    { key: 'phone', label: 'Phone', value: dojo.phone, Glyph: Phone, href: dojo.phone ? `tel:${dojo.phone}` : null },
    { key: 'website', label: 'Website', value: dojo.website, Glyph: Globe, href: dojo.website },
    { key: 'email', label: 'Email', value: dojo.email, Glyph: Mail, href: dojo.email ? `mailto:${dojo.email}` : null },
    {
      key: 'address',
      label: 'Address',
      value: [dojo.addressLine1, dojo.addressLine2].filter(Boolean).join(', ') || null,
      Glyph: MapPin,
      href: null,
    },
    { key: 'instructor', label: 'Instructor', value: dojo.instructorName, Glyph: User, href: null },
  ]

  const missing = fields.filter((f) => !f.value)

  return (
    <div className="screen">
      <SubHeader title="Dojo Information" fallbackTo="/more" />

      <Card variant="flush">
        <div
          style={{
            position: 'relative',
            background: 'linear-gradient(180deg, var(--sky-100), var(--blue-100))',
            padding: 'var(--s-6) var(--s-4) var(--s-7)',
            textAlign: 'center',
            overflow: 'hidden',
          }}
        >
          <MountainRidge
            className=""
            {...({ style: { position: 'absolute', inset: 'auto 0 0 0', height: 56, width: '100%' } } as object)}
          />
          <div style={{ position: 'relative', zIndex: 2 }}>
            <p style={{ fontSize: '1.25rem', fontWeight: 800, letterSpacing: '0.06em', color: 'var(--navy-900)' }}>
              BLUE RIDGE
            </p>
            <p style={{ fontWeight: 700, letterSpacing: '0.16em', color: 'var(--navy-700)' }}>
              MARTIAL ARTS
            </p>
            <p
              className="tiny bold"
              style={{
                letterSpacing: '0.2em',
                color: 'var(--navy-600)',
                borderTop: '1px solid var(--blue-300)',
                display: 'inline-block',
                paddingTop: 4,
                marginTop: 4,
              }}
            >
              {dojo.city.toUpperCase()}, {dojo.state}
            </p>
          </div>
        </div>

        <div style={{ padding: 'var(--s-4)' }}>
          <p className="small muted center" style={{ fontStyle: 'italic' }}>
            "Discipline Today. Confidence Tomorrow."
          </p>
        </div>
      </Card>

      {/* ------------------------------------------------------ the details */}
      <Card>
        <CardHead title="Contact" icon="mountain" />
        <ul className="rows" style={{ listStyle: 'none' }}>
          {fields.map(({ key, label, value, Glyph, href }) => (
            <li key={key} className="row" style={{ padding: 'var(--s-3) 0', alignItems: 'flex-start' }}>
              <span
                aria-hidden="true"
                style={{
                  flex: 'none',
                  width: 34,
                  height: 34,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 'var(--r-md)',
                  background: value ? 'var(--blue-100)' : 'var(--paper)',
                  color: value ? 'var(--blue-600)' : 'var(--ink-faint)',
                }}
              >
                <Glyph size={17} />
              </span>
              <span className="grow">
                <span className="tiny bold faint" style={{ display: 'block', letterSpacing: '0.05em' }}>
                  {label.toUpperCase()}
                </span>
                {value ? (
                  href ? (
                    <a href={href} className="bold">
                      {value}
                    </a>
                  ) : (
                    <span className="bold">{value}</span>
                  )
                ) : (
                  <span className="row" style={{ gap: 5, color: 'var(--orange-ink)', fontSize: '0.875rem' }}>
                    <AlertCircle size={14} aria-hidden="true" />
                    Add school contact information
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {missing.length > 0 ? (
        <Note tone="orange" icon="shield" title={`${missing.length} details still needed.`}>
          This demo has not been given the school's real {missing.map((m) => m.label.toLowerCase()).join(', ')}.
          Nothing has been invented in their place — supply the real details and they appear here.
        </Note>
      ) : null}

      <Card>
        <CardHead title="Class times" icon="calendar" />
        <div className="row-between">
          <span className="bold small">{DAY_NAMES[cls.dayIndex]}</span>
          <Chip icon="clock">{formatTimeRange(cls.startTime, cls.endTime)}</Chip>
        </div>
        <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
          Entered in the Instructor Demo area. Confirm the full class timetable with the school.
        </p>
      </Card>
    </div>
  )
}
