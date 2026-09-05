import { Link } from 'react-router-dom'
import { Card, Empty } from '../components/ui'
import { Masthead } from '../components/Masthead'

export function NotFoundScreen() {
  return (
    <>
      <Masthead />
      <div className="screen">
        <Card>
          <Empty icon="mountain" title="That page is not here">
            The link may be out of date. Everything in the app is reachable from the five buttons
            at the bottom of the screen.
          </Empty>
          <div className="grid-2" style={{ marginTop: 'var(--s-3)' }}>
            <Link to="/" className="btn btn--ghost">
              Home
            </Link>
            <Link to="/lessons" className="btn btn--ghost">
              Lessons
            </Link>
            <Link to="/practice" className="btn btn--ghost">
              Practice
            </Link>
            <Link to="/progress" className="btn btn--ghost">
              Progress
            </Link>
          </div>
        </Card>
      </div>
    </>
  )
}
