// IDP (Individual Development Plan) Module
// Integrates with search to help users build their IDP as they explore interviews

const IDP_STORAGE_KEY = 'trace_idp_data';

// IDP data structure
const IDP_TEMPLATE = {
  goals: Array(5).fill(null).map((_, i) => ({
    id: i + 1,
    title: '',
    type: '', // Project, Habit, Development
    domain: '', // Academic, Personal Well-being, Professional/Career Development
    specific: {
      goal: '',
      activities: ''
    },
    measurable: {
      success: '',
      dueDate: ''
    },
    abilities: '',
    relevant: '',
    tenable: {
      doable: '',
      resources: '',
      obstacles: '' // IF/THEN statements
    }
  })),
  supportTeam: Array(5).fill('').map((_, i) => ({ id: i + 1, name: '', role: '' })),
  timeline: '',
  notes: '',
  startedAt: null,
  lastUpdated: null
};

// IDP question prompts mapped to search topics
const IDP_PROMPTS = {
  'career': {
    question: 'Based on what you read about career paths, what specific career goal interests you?',
    field: 'specific.goal',
    hint: 'e.g., "My goal is to learn about policy careers in government or non-profit organizations"'
  },
  'mentorship': {
    question: 'Who could support your goals? Think about mentors or peers mentioned in the interviews.',
    field: 'supportTeam',
    hint: 'Add people to your support team who can help with your goals'
  },
  'skills': {
    question: 'What abilities do you want to develop based on these experiences?',
    field: 'abilities',
    hint: 'e.g., "I will develop my communication and interpersonal skills"'
  },
  'challenges': {
    question: 'What obstacles might you face? How can you plan for them?',
    field: 'tenable.obstacles',
    hint: 'Use IF/THEN: "IF I have trouble meeting people, THEN I will go to Career Planning Service"'
  },
  'funding': {
    question: 'What resources or support will you need to achieve your goals?',
    field: 'tenable.resources',
    hint: 'Consider funding, time, people, or other resources mentioned'
  },
  'networking': {
    question: 'What networking activities could help you reach your goals?',
    field: 'specific.activities',
    hint: 'e.g., "meet people working in policy careers, grow LinkedIn network"'
  },
  'work-life': {
    question: 'How does this goal fit with your personal well-being?',
    field: 'relevant',
    hint: 'Consider how this goal supports your overall well-being and values'
  },
  'teaching': {
    question: 'What teaching or communication skills do you want to develop?',
    field: 'abilities',
    hint: 'Think about presentation skills, mentoring, or other teaching abilities'
  },
  'transition': {
    question: 'What specific steps will help you transition to your next career phase?',
    field: 'specific.activities',
    hint: 'Break down your transition into concrete activities'
  },
  'mental health': {
    question: 'How will you maintain your well-being while pursuing these goals?',
    field: 'relevant',
    hint: 'Consider self-care, boundaries, and support systems'
  }
};

// Get IDP data from localStorage
function getIDP() {
  const stored = localStorage.getItem(IDP_STORAGE_KEY);
  if (stored) {
    return JSON.parse(stored);
  }
  // Initialize new IDP
  const newIDP = JSON.parse(JSON.stringify(IDP_TEMPLATE));
  newIDP.startedAt = new Date().toISOString();
  newIDP.lastUpdated = new Date().toISOString();
  saveIDP(newIDP);
  return newIDP;
}

// Save IDP to localStorage
function saveIDP(idp) {
  idp.lastUpdated = new Date().toISOString();
  localStorage.setItem(IDP_STORAGE_KEY, JSON.stringify(idp));
}

// Get relevant IDP prompt based on search terms
function getIDPPrompt(searchTerms) {
  const lowerTerms = searchTerms.map(t => t.toLowerCase());
  
  for (const [topic, prompt] of Object.entries(IDP_PROMPTS)) {
    if (lowerTerms.some(term => topic.includes(term) || term.includes(topic))) {
      return prompt;
    }
  }
  
  // Default prompt if no specific match
  return {
    question: 'What goal does this inspire for your own development?',
    field: 'specific.goal',
    hint: 'Consider setting a SMART goal based on what you learned'
  };
}

// Update IDP field
function updateIDPField(goalId, fieldPath, value) {
  const idp = getIDP();
  
  console.log('Updating IDP field:', { goalId, fieldPath, value });
  
  if (fieldPath === 'supportTeam') {
    const index = parseInt(goalId) - 1;
    if (index >= 0 && index < idp.supportTeam.length) {
      idp.supportTeam[index].name = value;
    }
  } else if (fieldPath === 'notes' || fieldPath === 'timeline') {
    idp[fieldPath] = value;
  } else {
    const goalIndex = parseInt(goalId) - 1;
    if (goalIndex >= 0 && goalIndex < idp.goals.length) {
      const goal = idp.goals[goalIndex];
      const pathParts = fieldPath.split('.');
      if (pathParts.length === 1) {
        goal[pathParts[0]] = value;
      } else if (pathParts.length === 2) {
        goal[pathParts[0]][pathParts[1]] = value;
      }
      console.log('Updated goal:', goal);
    }
  }
  
  saveIDP(idp);
  console.log('Saved IDP:', idp);
  return idp;
}

// Get next empty goal slot
function getNextEmptyGoalSlot(idp) {
  return idp.goals.findIndex(g => !g.title || !g.specific.goal);
}

// Export IDP as JSON
function exportIDP() {
  const idp = getIDP();
  const dataStr = JSON.stringify(idp, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trace-idp-${new Date().toISOString().split('T')[0]}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// Export IDP as text summary
function exportIDPText() {
  const idp = getIDP();
  let text = 'INDIVIDUAL DEVELOPMENT PLAN\n';
  text += '=' .repeat(50) + '\n\n';
  
  text += `Created: ${new Date(idp.startedAt).toLocaleDateString()}\n`;
  text += `Last Updated: ${new Date(idp.lastUpdated).toLocaleDateString()}\n\n`;
  
  text += 'SMART GOALS\n';
  text += '-'.repeat(50) + '\n';
  idp.goals.forEach((goal, i) => {
    if (goal.title || goal.specific.goal) {
      text += `\nGoal ${i + 1}: ${goal.title || 'Untitled'}\n`;
      text += `Type: ${goal.type}\n`;
      text += `Domain: ${goal.domain}\n\n`;
      text += `Specific:\n`;
      text += `  Goal: ${goal.specific.goal}\n`;
      text += `  Activities: ${goal.specific.activities}\n\n`;
      text += `Measurable:\n`;
      text += `  Success criteria: ${goal.measurable.success}\n`;
      text += `  Due date: ${goal.measurable.dueDate}\n\n`;
      text += `Abilities: ${goal.abilities}\n\n`;
      text += `Relevant: ${goal.relevant}\n\n`;
      text += `Tenable:\n`;
      text += `  Doable: ${goal.tenable.doable}\n`;
      text += `  Resources: ${goal.tenable.resources}\n`;
      text += `  Obstacles: ${goal.tenable.obstacles}\n`;
    }
  });
  
  text += '\n\nSUPPORT TEAM\n';
  text += '-'.repeat(50) + '\n';
  idp.supportTeam.forEach(person => {
    if (person.name) {
      text += `- ${person.name} (${person.role || 'Support'})\n`;
    }
  });
  
  text += '\n\nTIMELINE\n';
  text += '-'.repeat(50) + '\n';
  text += idp.timeline || 'Not specified\n';
  
  text += '\n\nNOTES\n';
  text += '-'.repeat(50) + '\n';
  text += idp.notes || 'No notes\n';
  
  const dataBlob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trace-idp-${new Date().toISOString().split('T')[0]}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

// Check if IDP has been started
function hasStartedIDP() {
  const idp = getIDP();
  return idp.goals.some(g => g.title || g.specific.goal);
}

// Get IDP progress percentage
function getIDPProgress() {
  const idp = getIDP();
  let filled = 0;
  let total = idp.goals.length * 7; // 7 fields per goal
  
  idp.goals.forEach(goal => {
    if (goal.title) filled++;
    if (goal.type) filled++;
    if (goal.domain) filled++;
    if (goal.specific.goal) filled++;
    if (goal.measurable.success) filled++;
    if (goal.abilities) filled++;
    if (goal.relevant) filled++;
  });
  
  return Math.round((filled / total) * 100);
}
