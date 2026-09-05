import type { Lesson } from '../types'

/**
 * The lesson library.
 *
 * Every drill here is SOLO, controlled, and done in open space. Nothing in
 * this file teaches sparring, contact with a partner, joint locks, chokes,
 * weapons, or striking a household object — see `src/test/safety.test.ts`,
 * which greps the whole library for that vocabulary and fails on it.
 */

/** The standard closing step. Every lesson ends the same way. */
const completeStep = (id: string, what: string) => ({
  id: `${id}-complete`,
  kind: 'complete' as const,
  title: 'Complete Lesson',
  summary: 'Log it and see what you earned.',
  points: [
    `You worked on ${what}.`,
    'Tell your instructor what felt easy and what felt hard.',
    'Finishing counts. Doing it again next week counts more.',
  ],
})

export const LESSONS: Lesson[] = [
  /* ------------------------------------------------------------ stance -- */
  {
    id: 'ready-stance',
    title: 'Ready Stance',
    tagline: 'Start strong. Everything begins here.',
    category: 'belt',
    beltId: 'white',
    difficulty: 'starter',
    estimatedMinutes: 6,
    skills: ['stance', 'balance', 'focus'],
    icon: 'stance',
    steps: [
      {
        id: 'ready-stance-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Get your body ready.',
        points: [
          'March in place for 20 slow steps.',
          'Roll your shoulders backward 5 times, then forward 5 times.',
          'Gently swing each leg forward and back 5 times, holding a wall.',
        ],
        durationSeconds: 120,
        safetyNote: 'Move slowly. Warming up should never hurt.',
      },
      {
        id: 'ready-stance-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'See the stance from the front and the side.',
        points: [
          'Feet about shoulder-width apart.',
          'Knees soft, not locked straight.',
          'Back tall, shoulders relaxed and down.',
          'Eyes forward, chin level.',
        ],
        durationSeconds: 60,
      },
      {
        id: 'ready-stance-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'The four checkpoints of a strong ready stance.',
        points: [
          'FEET — shoulder-width, weight even on both.',
          'KNEES — softly bent so you can move.',
          'BACK — tall, like a string is lifting your head.',
          'EYES — forward, not down at the floor.',
          'A good stance feels steady, not stiff.',
        ],
      },
      {
        id: 'ready-stance-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Drop into your stance and check all four points.',
        points: [
          'Stand normally, then step into your ready stance.',
          'Say the four checkpoints out loud as you check them.',
          'Relax and reset between each one.',
        ],
        targetReps: 10,
        safetyNote: 'Practice in a clear area with room to move.',
      },
      {
        id: 'ready-stance-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'How far apart should your feet be in a ready stance?',
            options: ['Together', 'About shoulder-width apart', 'As wide as you can'],
            answerIndex: 1,
            explanation:
              'Shoulder-width gives you a base that is steady but still lets you move.',
          },
          {
            id: 'q2',
            prompt: 'Should your knees be locked straight?',
            options: ['Yes, locked straight', 'No, softly bent'],
            answerIndex: 1,
            explanation:
              'Soft knees let you move in any direction. Locked knees make you slow and stiff.',
          },
          {
            id: 'q3',
            prompt: 'Where should your eyes be?',
            options: ['Down at your feet', 'Forward', 'Closed'],
            answerIndex: 1,
            explanation: 'Eyes forward keeps your posture tall and your focus where it belongs.',
          },
        ],
      },
      completeStep('ready-stance', 'your stance, balance and focus'),
    ],
  },

  /* ------------------------------------------------------------- guard -- */
  {
    id: 'guard-position',
    title: 'Guard Position',
    tagline: 'Hands up. Ready and protected.',
    category: 'belt',
    beltId: 'white',
    difficulty: 'starter',
    estimatedMinutes: 6,
    skills: ['guard', 'stance', 'focus'],
    icon: 'guard',
    steps: [
      {
        id: 'guard-position-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Loosen your arms and shoulders.',
        points: [
          'Shoulder rolls, 5 back and 5 forward.',
          'Open and close your hands 15 times.',
          'Gentle arm circles, 10 small ones each way.',
        ],
        durationSeconds: 90,
        safetyNote: 'Small, slow circles. Stop if anything pinches.',
      },
      {
        id: 'guard-position-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'Where the hands and elbows belong.',
        points: [
          'Hands up near cheek height.',
          'Elbows in, close to your ribs.',
          'Chin slightly down.',
          'Shoulders relaxed, not shrugged to your ears.',
        ],
        durationSeconds: 60,
      },
      {
        id: 'guard-position-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'A guard is a habit, not a pose.',
        points: [
          'Start in your ready stance.',
          'Bring both hands up, open or lightly closed.',
          'Keep elbows tucked in — wide elbows leave gaps.',
          'The hardest part is putting your hands BACK after you move them.',
          'Breathe normally. A tight guard is a tired guard.',
        ],
      },
      {
        id: 'guard-position-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Hands down, then snap back to guard.',
        points: [
          'Let your hands hang down by your sides.',
          'Bring them straight back up to guard.',
          'Check: cheeks, elbows in, chin down.',
        ],
        targetReps: 12,
      },
      {
        id: 'guard-position-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'Where should your elbows be in a good guard?',
            options: ['Wide out to the sides', 'Tucked in near your ribs'],
            answerIndex: 1,
            explanation: 'Elbows in keeps your guard tight and your shoulders relaxed.',
          },
          {
            id: 'q2',
            prompt: 'What is the hardest part of keeping a good guard?',
            options: [
              'Putting your hands back up after you move them',
              'Lifting your hands the first time',
            ],
            answerIndex: 0,
            explanation:
              'Anyone can put their hands up once. Bringing them back every single time is the skill.',
          },
        ],
      },
      completeStep('guard-position', 'your guard and your stance'),
    ],
  },

  /* ------------------------------------------------------------ punch --- */
  {
    id: 'straight-punch',
    title: 'Straight Punch',
    tagline: 'Controlled punches into open space.',
    category: 'belt',
    beltId: 'white',
    difficulty: 'starter',
    estimatedMinutes: 8,
    skills: ['punches', 'guard', 'stance'],
    icon: 'punch',
    steps: [
      {
        id: 'straight-punch-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Wrists and shoulders first.',
        points: [
          'Circle your wrists 10 times each way.',
          'Shoulder rolls, 5 each way.',
          'March in place for 20 steps.',
        ],
        durationSeconds: 90,
        safetyNote: 'Warm wrists matter. Never punch cold.',
      },
      {
        id: 'straight-punch-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'The punch travels straight out and straight back.',
        points: [
          'Start in ready stance with a good guard.',
          'The fist travels in a straight line, not a loop.',
          'The other hand stays up the whole time.',
          'The fist comes straight back to guard.',
        ],
        durationSeconds: 75,
      },
      {
        id: 'straight-punch-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'Straight out, straight back, hands home.',
        points: [
          'Make a proper fist: fingers rolled in, thumb OUTSIDE and across, never tucked inside.',
          'Punch into open air at about your own shoulder height.',
          'Keep your elbow soft at the end — do not snap it straight and locked.',
          'The other hand never drops.',
          'Slow and correct beats fast and sloppy every time.',
        ],
        safetyNote:
          'Punch into open space only. Never punch a wall, a door, furniture, a person or a pet.',
      },
      {
        id: 'straight-punch-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Alternate hands, slow and controlled.',
        points: [
          'Left, then right, then left again.',
          'Say "out — back" so the hand always returns.',
          'Count only the ones where your other hand stayed up.',
        ],
        targetReps: 20,
        safetyNote: 'Clear area, open space, controlled speed.',
      },
      {
        id: 'straight-punch-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'Where does your thumb go when you make a fist?',
            options: ['Tucked inside your fingers', 'Outside, across your fingers'],
            answerIndex: 1,
            explanation: 'A thumb tucked inside the fingers can get hurt. Thumb outside, always.',
          },
          {
            id: 'q2',
            prompt: 'What should you punch at home?',
            options: ['A wall or door', 'Open space', 'A pillow held by someone'],
            answerIndex: 1,
            explanation:
              'At home you punch open space only. Pads and targets are for the dojo, with your instructor.',
          },
          {
            id: 'q3',
            prompt: 'What does your other hand do while you punch?',
            options: ['Drops to your side', 'Stays up in guard'],
            answerIndex: 1,
            explanation: 'Hands come back home. That habit is worth more than a hard punch.',
          },
        ],
      },
      completeStep('straight-punch', 'controlled punching and keeping your guard'),
    ],
  },

  /* -------------------------------------------------------------- kick -- */
  {
    id: 'front-kick-basics',
    title: 'Front Kick Basics',
    tagline: 'Kick higher. Grow stronger.',
    category: 'belt',
    beltId: 'white',
    difficulty: 'building',
    estimatedMinutes: 8,
    skills: ['kicks', 'balance', 'focus'],
    icon: 'kick',
    steps: [
      {
        id: 'front-kick-basics-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Legs and hips before any kicking.',
        points: [
          'March in place, knees high, 20 steps.',
          'Hold a wall and swing each leg gently forward and back, 8 each.',
          'Rise onto your toes and back down, 10 times.',
        ],
        durationSeconds: 120,
        safetyNote: 'Hold a wall or chair for balance. Never kick with cold legs.',
      },
      {
        id: 'front-kick-basics-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'Chamber, extend, re-chamber, set down.',
        points: [
          'Knee comes up first — that is the chamber.',
          'The lower leg extends forward.',
          'The lower leg comes BACK before the foot lands.',
          'Foot sets down under control, back into stance.',
        ],
        durationSeconds: 75,
      },
      {
        id: 'front-kick-basics-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'Four counts. Never three.',
        points: [
          'ONE — lift the knee up in front of you.',
          'TWO — extend the lower leg into open space.',
          'THREE — pull the lower leg back to the chamber.',
          'FOUR — set the foot down into your stance.',
          'Kick low at first. Height comes later, control comes first.',
          'Hands stay in guard the whole time.',
        ],
        safetyNote:
          'Kick into open space. Hold a wall or chair if you need to. Stop if anything hurts.',
      },
      {
        id: 'front-kick-basics-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: '5 with each leg, counting all four parts.',
        points: [
          'Count out loud: one, two, three, four.',
          'Right leg 5 times, then left leg 5 times.',
          'Only count a rep where the foot came back under control.',
        ],
        targetReps: 10,
        safetyNote: 'Clear space all around you, especially in front.',
      },
      {
        id: 'front-kick-basics-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'What is the FIRST part of a front kick?',
            options: ['Extending your foot', 'Lifting your knee', 'Leaning back'],
            answerIndex: 1,
            explanation: 'Knee up first. That chamber is what makes the kick controlled.',
          },
          {
            id: 'q2',
            prompt: 'What happens right before your foot lands?',
            options: [
              'The lower leg comes back to the chamber',
              'You let it drop wherever it lands',
            ],
            answerIndex: 0,
            explanation:
              'Re-chambering is what separates a martial arts kick from a swing of the leg.',
          },
          {
            id: 'q3',
            prompt: 'Should you kick as high as you possibly can right away?',
            options: ['Yes, height first', 'No, control first'],
            answerIndex: 1,
            explanation: 'Low and controlled builds the habit. Height follows on its own.',
          },
        ],
      },
      completeStep('front-kick-basics', 'your front kick, balance and control'),
    ],
  },

  /* ---------------------------------------------------------- footwork -- */
  {
    id: 'movement-footwork',
    title: 'Movement and Footwork',
    tagline: 'Move without losing your base.',
    category: 'skills',
    beltId: 'white-1',
    difficulty: 'building',
    estimatedMinutes: 7,
    skills: ['footwork', 'stance', 'balance'],
    icon: 'footwork',
    steps: [
      {
        id: 'movement-footwork-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Ankles and calves.',
        points: [
          'Ankle circles, 10 each way, each foot.',
          'Heel raises, 12 slow ones.',
          'Side-to-side weight shifts, 20.',
        ],
        durationSeconds: 90,
      },
      {
        id: 'movement-footwork-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'The stance travels with you.',
        points: [
          'Step with the front foot first when moving forward.',
          'Step with the back foot first when moving backward.',
          'Feet never cross over each other.',
          'You should be able to stop and be in a good stance at any moment.',
        ],
        durationSeconds: 60,
      },
      {
        id: 'movement-footwork-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'Slide, do not hop.',
        points: [
          'Keep your feet low — slide them, do not jump.',
          'Keep the same width between your feet the whole time.',
          'Head stays level. If your head bobs, you are hopping.',
          'Hands stay in guard while you move.',
        ],
        safetyNote: 'Clear the floor first. No rugs, cords, toys or furniture in your path.',
      },
      {
        id: 'movement-footwork-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Forward, back, left, right.',
        points: [
          'Two steps forward, two steps back — that is one rep.',
          'Then two steps left, two steps right — that is another.',
          'Freeze at the end of each rep and check your stance.',
        ],
        targetReps: 12,
      },
      {
        id: 'movement-footwork-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'When you move forward, which foot goes first?',
            options: ['The back foot', 'The front foot'],
            answerIndex: 1,
            explanation: 'Lead with the foot nearest where you are going, then follow with the other.',
          },
          {
            id: 'q2',
            prompt: 'What does a bobbing head tell you?',
            options: ['You are moving well', 'You are hopping instead of sliding'],
            answerIndex: 1,
            explanation: 'A level head means your feet are staying low and your base is holding.',
          },
        ],
      },
      completeStep('movement-footwork', 'footwork and keeping your base'),
    ],
  },

  /* ----------------------------------------------------------- balance -- */
  {
    id: 'balance-drill',
    title: 'Balance Drill',
    tagline: 'Steady beats fast.',
    category: 'skills',
    beltId: 'white',
    difficulty: 'building',
    estimatedMinutes: 6,
    skills: ['balance', 'focus', 'stance'],
    icon: 'balance',
    steps: [
      {
        id: 'balance-drill-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Wake your feet and ankles up.',
        points: [
          'Ankle circles, 10 each way.',
          'Rise onto your toes and lower slowly, 10 times.',
          'Walk heel-to-toe in a straight line, 10 steps.',
        ],
        durationSeconds: 90,
        safetyNote: 'Stand near a wall you can touch if you wobble.',
      },
      {
        id: 'balance-drill-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'Where to look, and what to hold still.',
        points: [
          'Pick one spot on the wall and keep your eyes on it.',
          'Lift one knee to about hip height.',
          'Arms out or in guard, whichever helps you hold it.',
          'Breathe. Holding your breath makes balance harder.',
        ],
        durationSeconds: 45,
      },
      {
        id: 'balance-drill-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'Balance is a skill, not a talent.',
        points: [
          'Eyes on one still spot — moving eyes make a moving body.',
          'Press your standing foot into the floor, toes spread.',
          'Wobbling is normal. Catching yourself IS the training.',
          'Start at 10 seconds. Build up a little each week.',
        ],
        safetyNote: 'Stay within arm’s reach of a wall or chair.',
      },
      {
        id: 'balance-drill-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Hold, switch, repeat.',
        points: [
          'Hold your right knee up for 15 seconds.',
          'Switch to the left for 15 seconds. That is one rep.',
          'Rest for a moment between reps.',
        ],
        targetReps: 6,
      },
      {
        id: 'balance-drill-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'Where should your eyes be while balancing?',
            options: ['Moving around the room', 'On one still spot', 'Closed'],
            answerIndex: 1,
            explanation: 'A still gaze gives your body a still reference to work from.',
          },
          {
            id: 'q2',
            prompt: 'What does it mean if you wobble?',
            options: ['You are bad at balance', 'Your balance is being trained'],
            answerIndex: 1,
            explanation: 'The catch is the exercise. Wobbling and recovering is exactly the point.',
          },
        ],
      },
      completeStep('balance-drill', 'balance and focus'),
    ],
  },

  /* ------------------------------------------------------------- focus -- */
  {
    id: 'focus-drill',
    title: 'Focus Drill',
    tagline: 'Train your attention like a muscle.',
    category: 'character',
    beltId: 'white',
    difficulty: 'starter',
    estimatedMinutes: 5,
    skills: ['focus', 'etiquette'],
    icon: 'focus',
    steps: [
      {
        id: 'focus-drill-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Settle your body so your mind can settle.',
        points: [
          'Stand in your ready stance.',
          'Take 5 slow breaths — in through the nose, out through the mouth.',
          'Let your shoulders drop on each breath out.',
        ],
        durationSeconds: 60,
      },
      {
        id: 'focus-drill-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'What focus actually looks like.',
        points: [
          'Eyes still and forward.',
          'Body quiet — no fidgeting, no swaying.',
          'Listening all the way to the end of an instruction.',
          'Answering with "Yes sir" or "Yes ma’am" the way your dojo does.',
        ],
        durationSeconds: 45,
      },
      {
        id: 'focus-drill-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'Attention wanders. Bringing it back is the skill.',
        points: [
          'Your mind WILL wander. That is not failing.',
          'Notice it, then bring your eyes back to your spot.',
          'Count your breaths — if you lose count, start again at one.',
          'Every time you bring it back, your focus gets a little stronger.',
        ],
      },
      {
        id: 'focus-drill-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Stillness holds, one at a time.',
        points: [
          'Stand still in your ready stance for 20 seconds.',
          'Eyes on one spot, body quiet, breathing slow.',
          'Rest, shake it out, then do it again.',
        ],
        targetReps: 5,
      },
      {
        id: 'focus-drill-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'What should you do when your mind wanders?',
            options: ['Give up for today', 'Notice it and bring it back'],
            answerIndex: 1,
            explanation: 'Bringing your attention back is the whole exercise. It is meant to wander.',
          },
          {
            id: 'q2',
            prompt: 'What does good listening look like in class?',
            options: [
              'Answering before the instructor finishes',
              'Listening all the way to the end, then answering',
            ],
            answerIndex: 1,
            explanation: 'Hearing the whole instruction is respect, and it is also how you get it right.',
          },
        ],
      },
      completeStep('focus-drill', 'focus and self-control'),
    ],
  },

  /* --------------------------------------------------------- etiquette -- */
  {
    id: 'dojo-etiquette',
    title: 'Dojo Etiquette',
    tagline: 'Respect on and off the mat.',
    category: 'character',
    beltId: 'white',
    difficulty: 'starter',
    estimatedMinutes: 5,
    skills: ['etiquette', 'focus'],
    icon: 'etiquette',
    steps: [
      {
        id: 'dojo-etiquette-warmup',
        kind: 'warmup',
        title: 'Warm-Up',
        summary: 'Stand the way you would at the edge of the mat.',
        points: [
          'Ready stance, tall and still.',
          'Uniform straight, belt tied.',
          'Three slow breaths.',
        ],
        durationSeconds: 45,
      },
      {
        id: 'dojo-etiquette-demo',
        kind: 'demo',
        title: 'Watch the Demo',
        summary: 'The bow, and when it is used.',
        points: [
          'Feet together, hands at your sides.',
          'Bend from the waist, about 30 degrees.',
          'Eyes down for a moment, then back up.',
          'Bow when you step on the mat, when you step off, and to your instructor.',
        ],
        durationSeconds: 45,
      },
      {
        id: 'dojo-etiquette-learn',
        kind: 'learn',
        title: 'Learn the Technique',
        summary: 'Etiquette is respect you can see.',
        points: [
          'Arrive on time and ready — that is respect for everyone else’s class.',
          'Uniform clean, belt tied properly.',
          'Listen without interrupting.',
          'Help someone newer than you without being asked.',
          'Say thank you to your instructor at the end.',
          'What you practise here works at home and at school too.',
        ],
      },
      {
        id: 'dojo-etiquette-reps',
        kind: 'reps',
        title: 'Practice Reps',
        summary: 'Practise your bow.',
        points: [
          'Feet together, hands at your sides.',
          'Bow slowly, hold for one second, come back up tall.',
          'Do it as if your instructor were standing there.',
        ],
        targetReps: 8,
      },
      {
        id: 'dojo-etiquette-check',
        kind: 'check',
        title: 'Check Understanding',
        summary: 'Show what you know.',
        points: [],
        questions: [
          {
            id: 'q1',
            prompt: 'When do you bow?',
            options: [
              'Only at the start of class',
              'Stepping on the mat, stepping off, and to your instructor',
            ],
            answerIndex: 1,
            explanation: 'The bow marks respect at every threshold, not just once.',
          },
          {
            id: 'q2',
            prompt: 'Someone newer than you is struggling. What do you do?',
            options: ['Help them without being asked', 'Wait until the instructor tells you to'],
            answerIndex: 0,
            explanation: 'Helping without being asked is one of the clearest signs of a senior student.',
          },
        ],
      },
      completeStep('dojo-etiquette', 'etiquette, respect and focus'),
    ],
  },
]

const BY_ID = new Map(LESSONS.map((l) => [l.id, l]))

export function lessonById(id: string): Lesson | undefined {
  return BY_ID.get(id)
}
