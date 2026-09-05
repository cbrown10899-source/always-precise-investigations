import { SubHeader } from '../components/SubHeader'
import { Icon } from '../components/Icon'
import { Card, CardHead, Note } from '../components/ui'

/**
 * The safety screen.
 *
 * The four rules here are the same four repeated on every lesson and practice
 * screen, in the same words. What is NOT taught at home is stated explicitly,
 * so a child reading it knows the difference between home practice and class
 * rather than having to infer it from absence.
 */
const RULES = [
  {
    icon: 'shield' as const,
    title: 'Practise in a clear area',
    body: 'Move furniture, cords, toys and pets out of the way first. You need room to step in every direction and space above your head.',
  },
  {
    icon: 'balance' as const,
    title: 'Move slowly and stay in control',
    body: 'Slow and correct beats fast and sloppy every single time. If you cannot stop a movement halfway, it is too fast.',
  },
  {
    icon: 'heart' as const,
    title: 'Stop if something hurts',
    body: 'Aching muscles the next day is normal. Sharp pain, a joint that hurts, or feeling dizzy means stop and tell an adult.',
  },
  {
    icon: 'etiquette' as const,
    title: 'Practise with permission',
    body: 'Always check with a parent or your instructor before practising at home, and tell them what you are working on.',
  },
]

const NOT_AT_HOME = [
  'Practising with or against another person',
  'Sparring of any kind',
  'Punching or kicking walls, doors, furniture or anything else',
  'Weapons of any kind',
  'Holds, locks or anything applied to another person',
  'Anything your instructor has not shown you in class',
]

export function SafetyScreen() {
  return (
    <div className="screen">
      <SubHeader title="Safety" subtitle="How to practise safely at home" fallbackTo="/more" />

      <Note tone="green" icon="shield" title="Everything in this app is solo practice.">
        Every drill here is done on your own, in open space, at a speed you control.
      </Note>

      <div className="stack">
        {RULES.map((rule) => (
          <Card key={rule.title}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span
                aria-hidden="true"
                style={{
                  flex: 'none',
                  width: 42,
                  height: 42,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--green-tint)',
                  color: 'var(--green-ink)',
                }}
              >
                <Icon name={rule.icon} size={21} />
              </span>
              <div className="grow">
                <h3>{rule.title}</h3>
                <p className="small muted" style={{ marginTop: 2 }}>
                  {rule.body}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHead title="Not at home — class only" icon="shield" />
        <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
          These belong in the dojo, with your instructor supervising. They are never part of home
          practice.
        </p>
        <ul className="stack-2" style={{ listStyle: 'none' }}>
          {NOT_AT_HOME.map((item) => (
            <li key={item} className="row" style={{ alignItems: 'flex-start', gap: 'var(--s-2)' }}>
              <span
                aria-hidden="true"
                style={{
                  flex: 'none',
                  marginTop: 6,
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: 'var(--orange-solid)',
                }}
              />
              <span className="small">{item}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHead title="Before every practice" icon="warmup" />
        <ol className="numbered">
          <li className="small">Ask a parent or your instructor.</li>
          <li className="small">Clear the space around you.</li>
          <li className="small">Warm up — never start cold.</li>
          <li className="small">Have water nearby.</li>
          <li className="small">Finish with a cool down.</li>
        </ol>
      </Card>

      <Note tone="gold" icon="heart" title="A note for parents.">
        This app supports what a child is taught in class. It is not a substitute for qualified
        instruction, and it deliberately teaches no partner work, contact drills or techniques that
        need supervision.
      </Note>
    </div>
  )
}
