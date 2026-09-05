import { Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { BottomNav } from '../components/BottomNav'
import { BadgeCelebration } from '../components/BadgeCelebration'
import { HomeScreen } from '../screens/HomeScreen'
import { LessonsScreen } from '../screens/LessonsScreen'
import { LessonDetailScreen } from '../screens/LessonDetailScreen'
import { PracticeScreen } from '../screens/PracticeScreen'
import { GuidedPracticeScreen } from '../screens/GuidedPracticeScreen'
import { ProgressScreen } from '../screens/ProgressScreen'
import { MoreScreen } from '../screens/MoreScreen'
import { ProfileScreen } from '../screens/ProfileScreen'
import { ParentModeScreen } from '../screens/ParentModeScreen'
import { InstructorDemoScreen } from '../screens/InstructorDemoScreen'
import { ScheduleScreen } from '../screens/ScheduleScreen'
import { DojoInfoScreen } from '../screens/DojoInfoScreen'
import { SafetyScreen } from '../screens/SafetyScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { NotFoundScreen } from '../screens/NotFoundScreen'

/** Routes that take over the whole viewport and hide the shell chrome. */
const FULLSCREEN = ['/practice/session']

export function App() {
  const location = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  const isFullscreen = FULLSCREEN.some((path) => location.pathname.startsWith(path))

  // Scroll to the top on navigation. Without this a deep scroll position is
  // carried into the next screen, which reads as a screen that opened halfway
  // down. Focus is deliberately NOT moved: arriving somewhere must not raise a
  // phone keyboard or steal the caret.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={() => mainRef.current?.focus()}>
        Skip to main content
      </a>

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={`app__main ${isFullscreen ? 'app__main--bare' : ''}`.trim()}
      >
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/lessons" element={<LessonsScreen />} />
          <Route path="/lessons/:lessonId" element={<LessonDetailScreen />} />
          <Route path="/practice" element={<PracticeScreen />} />
          <Route path="/practice/session/:routineId" element={<GuidedPracticeScreen />} />
          <Route path="/progress" element={<ProgressScreen />} />
          <Route path="/more" element={<MoreScreen />} />
          <Route path="/profile" element={<ProfileScreen />} />
          <Route path="/parent" element={<ParentModeScreen />} />
          <Route path="/instructor" element={<InstructorDemoScreen />} />
          <Route path="/schedule" element={<ScheduleScreen />} />
          <Route path="/dojo" element={<DojoInfoScreen />} />
          <Route path="/safety" element={<SafetyScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<NotFoundScreen />} />
        </Routes>
      </main>

      {isFullscreen ? null : <BottomNav />}
      <BadgeCelebration />
    </div>
  )
}
