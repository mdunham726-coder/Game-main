// QuestSystem.js - Phase 3B: Complete Quest Framework with DeepSeek Integration
// Ultimate Dungeon Master AI Game Engine - Quest System
// Implements constraint-first architecture with full API integration

const crypto = require('crypto');
const axios = require('axios');

// =============================================================================
// CONSTANTS AND CONFIGURATION
// =============================================================================

const QUEST_CONFIG = {
  // Difficulty tiers with reward ranges (locked constraints)
  DIFFICULTY_TIERS: {
    trivial: { minGold: 5, maxGold: 25, weight: 0.15 },
    easy: { minGold: 25, maxGold: 75, weight: 0.30 },
    moderate: { minGold: 75, maxGold: 250, weight: 0.35 },
    hard: { minGold: 250, maxGold: 750, weight: 0.15 },
    deadly: { minGold: 750, maxGold: 2000, weight: 0.05 }
  },

  // Settlement type probabilities for quest availability
  SETTLEMENT_QUEST_PROBABILITY: {
    hamlet: { min: 0.10, max: 0.20 },
    village: { min: 0.30, max: 0.40 },
    town: { min: 0.50, max: 0.70 },
    city: { min: 0.80, max: 1.00 }
  },

  // Allowed enemy types by difficulty (prevents scope creep)
  ALLOWED_ENEMY_TYPES: {
    trivial: ['wildlife', 'vermin', 'beggars'],
    easy: ['bandits', 'wildlife', 'cultists', 'guards'],
    moderate: ['bandits', 'cultists', 'mercenaries', 'beasts'],
    hard: ['mercenaries', 'beasts', 'monsters', 'assassins'],
    deadly: ['monsters', 'assassins', 'warlords', 'ancient_creatures']
  },

  // Forbidden keywords to prevent power scaling
  FORBIDDEN_KEYWORDS: {
    trivial: ['dragon', 'warlord', 'ancient', 'demon', 'god'],
    easy: ['dragon', 'warlord', 'ancient', 'demon', 'god'],
    moderate: ['dragon', 'warlord', 'ancient', 'demon', 'god'],
    hard: ['dragon', 'god'], // Allow some escalation at higher tiers
    deadly: ['god'] // Only gods are forbidden at deadly tier
  },

  // Quest complexity types and distribution
  COMPLEXITY_TYPES: {
    single: { weight: 0.30, steps: 1 },
    short: { weight: 0.40, steps: [2, 3] },
    medium: { weight: 0.20, steps: [4, 6] },
    dynamic: { weight: 0.10, steps: [3, 5] }
  },

  // Travel distance constraints
  TRAVEL_DISTANCE: {
    trivial: { min: 0, max: 1 },
    easy: { min: 1, max: 3 },
    moderate: { min: 2, max: 5 },
    hard: { min: 3, max: 8 },
    deadly: { min: 5, max: 12 }
  }
};
// =============================================================================
// CORE QUEST ENGINE - CONSTRAINT ROLLING (FIXED RNG)
// =============================================================================

class QuestConstraintEngine {
  constructor(seed = null) {
    this.rngState = this._initializeRNGState(seed);
    this.callCount = 0;
    this.generatedQuests = new Map();
  }

  /**
   * Initialize deterministic RNG state
   */
  _initializeRNGState(seed) {
    const baseSeed = seed || Date.now();
    return crypto.createHash('sha256').update(String(baseSeed)).digest('hex');
  }

  /**
   * Get next random value (fixed non-recursive implementation)
   */
  _nextRandom() {
    this.callCount++;
    this.rngState = crypto.createHash('sha256')
      .update(this.rngState + this.callCount)
      .digest('hex');
    return parseInt(this.rngState.substring(0, 8), 16) / 0xFFFFFFFF;
  }

  /**
   * Public RNG interface
   */
  get rng() {
    return {
      next: (min = 0, max = 1) => {
        const randomValue = this._nextRandom();
        return min + Math.floor(randomValue * (max - min + 1));
      },
      random: () => this._nextRandom(),
      choice: (array) => {
        if (!array.length) return null;
        const index = Math.floor(this._nextRandom() * array.length);
        return array[index];
      },
      weightedChoice: (weightedArray) => {
        const totalWeight = weightedArray.reduce((sum, item) => sum + item.weight, 0);
        let random = this._nextRandom() * totalWeight;
        
        for (const item of weightedArray) {
          random -= item.weight;
          if (random <= 0) return item;
        }
        return weightedArray[weightedArray.length - 1];
      }
    };
  }

  /**
   * Roll quest constraints based on settlement and world context
   */
  rollQuestConstraints(settlementContext, questTier = 'random') {
    const constraints = {
      id: this._generateQuestId(),
      tier: questTier,
      status: 'available',
      difficulty: this._rollDifficulty(settlementContext),
      reward_gold: 0,
      reward_items: this._rollItemRewardCount(),
      enemy_types: [],
      enemy_count: 0,
      complexity: this._rollComplexity(),
      travel_distance: 0,
      forbidden_keywords: [],
      settlement_type: settlementContext.type,
      population: settlementContext.population,
      created_at: new Date().toISOString()
    };

    // Set derived constraints
    constraints.reward_gold = this._rollRewardGold(constraints.difficulty);
    constraints.enemy_types = this._rollEnemyTypes(constraints.difficulty);
    constraints.enemy_count = this._rollEnemyCount(constraints.difficulty);
    constraints.travel_distance = this._rollTravelDistance(constraints.difficulty);
    constraints.forbidden_keywords = QUEST_CONFIG.FORBIDDEN_KEYWORDS[constraints.difficulty];

    return constraints;
  }

  _rollDifficulty(settlementContext) {
    const baseWeights = Object.entries(QUEST_CONFIG.DIFFICULTY_TIERS)
      .map(([tier, config]) => ({ tier, weight: config.weight }));
    
    const sizeModifier = {
      hamlet: { trivial: 0.3, easy: 0.4, moderate: 0.2, hard: 0.1, deadly: 0.0 },
      village: { trivial: 0.2, easy: 0.4, moderate: 0.3, hard: 0.1, deadly: 0.0 },
      town: { trivial: 0.1, easy: 0.3, moderate: 0.4, hard: 0.15, deadly: 0.05 },
      city: { trivial: 0.05, easy: 0.2, moderate: 0.4, hard: 0.25, deadly: 0.1 }
    };

    const modifier = sizeModifier[settlementContext.type] || sizeModifier.town;
    const adjustedWeights = baseWeights.map(({ tier, weight }) => ({
      tier,
      weight: weight * (modifier[tier] || 1.0)
    }));

    return this.rng.weightedChoice(adjustedWeights).tier;
  }

  _rollRewardGold(difficulty) {
    const tier = QUEST_CONFIG.DIFFICULTY_TIERS[difficulty];
    return this.rng.next(tier.minGold, tier.maxGold);
  }

  _rollEnemyTypes(difficulty) {
    const allowed = QUEST_CONFIG.ALLOWED_ENEMY_TYPES[difficulty];
    const count = this.rng.next(1, Math.min(3, allowed.length));
    const selected = new Set();
    
    while (selected.size < count) {
      selected.add(this.rng.choice(allowed));
    }
    
    return Array.from(selected);
  }

  _rollEnemyCount(difficulty) {
    const baseRanges = {
      trivial: [0, 1], easy: [0, 2], moderate: [1, 4], 
      hard: [2, 6], deadly: [3, 10]
    };
    const range = baseRanges[difficulty];
    return this.rng.next(range[0], range[1]);
  }

  _rollTravelDistance(difficulty) {
    const range = QUEST_CONFIG.TRAVEL_DISTANCE[difficulty];
    return this.rng.next(range.min, range.max);
  }

  _rollItemRewardCount() {
    const roll = this._nextRandom();
    if (roll < 0.70) return 0;
    if (roll < 0.95) return 1;
    return 2;
  }

  _rollComplexity() {
    const complexityOptions = Object.entries(QUEST_CONFIG.COMPLEXITY_TYPES)
      .map(([type, config]) => ({ type, weight: config.weight }));
    return this.rng.weightedChoice(complexityOptions).type;
  }

  _generateQuestId() {
    const timestamp = Date.now();
    const random = this.rng.next(1000, 9999);
    return `quest_${timestamp}_${random}`;
  }
}
// =============================================================================
// DEEPSEEK API INTEGRATION
// =============================================================================

class DeepSeekIntegration {
  constructor(apiKey = null) {
    this.apiKey = apiKey || process.env.DEEPSEEK_API_KEY;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * Generate complete quest narrative from constraints
   */
  async generateQuestNarrative(questTemplate) {
    if (!this.apiKey) {
      throw new Error('DeepSeek API key not configured');
    }

    const prompt = this._buildNarrativePrompt(questTemplate);
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this._callDeepSeekAPI(prompt);
        const narrative = this._parseAPIResponse(response);
        
        return {
          success: true,
          narrative,
          attempt
        };
        
      } catch (error) {
        console.warn(`[DEEPSEEK] Attempt ${attempt} failed:`, error.message);
        
        if (attempt === this.maxRetries) {
          return {
            success: false,
            error: error.message,
            attempt
          };
        }
        
        // Exponential backoff
        await new Promise(resolve => 
          setTimeout(resolve, this.retryDelay * Math.pow(2, attempt - 1))
        );
      }
    }
  }

  /**
   * Build constraint-enforced prompt for DeepSeek
   */
  _buildNarrativePrompt(questTemplate) {
    const constraints = questTemplate.constraints;
    
    let prompt = `You are creating a quest for a text adventure game. Follow these HARD CONSTRAINTS exactly:\n\n`;
    
    prompt += `SETTLEMENT: ${constraints.settlement_type}, Population: ${constraints.population}\n`;
    prompt += `DIFFICULTY: ${constraints.difficulty}\n`;
    prompt += `REWARD: Exactly ${constraints.reward_gold} gold (DO NOT DEVIATE)\n`;
    prompt += `ENEMIES: ${constraints.enemy_count} enemies of type: ${constraints.enemy_types.join(', ')}\n`;
    prompt += `TRAVEL: Player must travel ${constraints.travel_distance} locations\n`;
    prompt += `COMPLEXITY: ${constraints.complexity} quest with ${questTemplate.steps.length} steps\n`;
    prompt += `FORBIDDEN: DO NOT mention: ${constraints.forbidden_keywords.join(', ')}\n\n`;
    
    prompt += `QUEST STRUCTURE (pre-defined steps):\n`;
    questTemplate.steps.forEach((step, index) => {
      prompt += `Step ${index + 1}: ${step.choices.length} choices leading to different steps\n`;
    });
    
    prompt += `\nCREATIVE REQUIREMENTS:\n`;
    prompt += `1. Create compelling protagonist (NPC with personality, faction, reputation)\n`;
    prompt += `2. Define clear antagonist/obstacle with motivation\n`;
    prompt += `3. Write engaging quest narrative\n`;
    prompt += `4. Describe objective clearly\n`;
    prompt += `5. Explain why the reward makes narrative sense\n`;
    prompt += `6. Include 2-3 narrative hooks\n`;
    prompt += `7. Add moral complications or interesting story elements\n`;
    prompt += `8. Generate consequences for each choice in all steps\n\n`;
    
    prompt += `BE CREATIVE ABOUT: Character motivations, story hooks, moral dilemmas\n`;
    prompt += `DO NOT BE CREATIVE ABOUT: Power level, rewards, enemy types, difficulty\n\n`;
    
    prompt += `Return ONLY valid JSON with this exact structure:\n`;
    prompt += `{\n`;
    prompt += `  "protagonist": { "name": "...", "description": "...", "faction": "...", "reputation": "..." },\n`;
    prompt += `  "antagonist": { "name": "...", "type": "...", "motivation": "..." },\n`;
    prompt += `  "narrative": "...",\n`;
    prompt += `  "objective_description": "...",\n`;
    prompt += `  "reward_description": "...",\n`;
    prompt += `  "narrative_hooks": ["...", "..."],\n`;
    prompt += `  "complications": "...",\n`;
    prompt += `  "step_narratives": [\n`;
    prompt += `    { "step_id": "step_1", "narrative": "...", "objective": "..." },\n`;
    prompt += `    { "step_id": "step_2", "narrative": "...", "objective": "..." }\n`;
    prompt += `  ],\n`;
    prompt += `  "choice_consequences": [\n`;
    prompt += `    { "choice_id": "choice_1_1", "consequence": "..." },\n`;
    prompt += `    { "choice_id": "choice_1_2", "consequence": "..." }\n`;
    prompt += `  ]\n`;
    prompt += `}`;

    return prompt;
  }

  /**
   * Call DeepSeek API with prompt
   */
  async _callDeepSeekAPI(prompt) {
    
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: prompt
      }],
      temperature: 0.7,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return response.data.choices[0].message.content;
  }

  /**
   * Parse and validate API response
   */
  _parseAPIResponse(content) {
    try {
      // Extract JSON from response if it's wrapped in markdown
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || 
                       content.match(/{[\s\S]*}/);
      
      const jsonString = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
      const parsed = JSON.parse(jsonString);
      
      return parsed;
    } catch (error) {
      throw new Error(`Failed to parse DeepSeek response: ${error.message}`);
    }
  }

  /**
   * Generate revision prompt for validation failures
   */
  generateRevisionPrompt(originalPrompt, violations) {
    return `${originalPrompt}\n\nREVISION REQUIRED - VIOLATIONS DETECTED:\n${violations.join('\n')}\n\nPlease correct these issues and return valid JSON.`;
  }
}
// =============================================================================
// ENHANCED FALLBACK QUEST SYSTEM
// =============================================================================

class FallbackQuestSystem {
  constructor(constraintEngine) {
    this.constraintEngine = constraintEngine;
  }

  /**
   * Generate constraint-respecting fallback quests
   */
  generateFallbackQuest(constraints) {
    const template = this._selectAppropriateTemplate(constraints);
    const filled = this._fillTemplateWithConstraints(template, constraints);
    
    // Generate complete quest structure
    return {
      protagonist: filled.protagonist,
      antagonist: filled.antagonist,
      narrative: filled.narrative,
      objective_description: filled.objective_description,
      reward_description: filled.reward_description,
      narrative_hooks: filled.narrative_hooks,
      complications: filled.complications,
      step_narratives: this._generateStepNarratives(constraints, filled),
      choice_consequences: this._generateChoiceConsequences(constraints),
      is_fallback: true
    };
  }

  /**
   * Select template matching difficulty and constraints
   */
  _selectAppropriateTemplate(constraints) {
    const templates = {
      trivial: this._getTrivialTemplates(),
      easy: this._getEasyTemplates(),
      moderate: this._getModerateTemplates(),
      hard: this._getHardTemplates(),
      deadly: this._getDeadlyTemplates()
    };

    const difficultyTemplates = templates[constraints.difficulty] || templates.moderate;
    return this.constraintEngine.rng.choice(difficultyTemplates);
  }

  _getTrivialTemplates() {
    return [{
      protagonist: { name: "Worried Villager", description: "A concerned local with a small problem", faction: "Village", reputation: "Neutral" },
      antagonist: { name: "Minor Nuisance", type: "wildlife", motivation: "Basic survival needs" },
      narrative: "A small problem has been bothering the locals around ${settlement}. It's nothing serious, but someone needs to handle it.",
      objective_description: "Deal with the minor issue causing trouble for the villagers.",
      reward_description: "The villagers have pooled ${reward_gold} gold for your help.",
      narrative_hooks: ["It's been going on for a few days", "Nobody else has time to deal with it"],
      complications: "The situation might be slightly more complicated than it first appears."
    }];
  }

  _getEasyTemplates() {
    return [{
      protagonist: { name: "Local Merchant", description: "A business owner facing difficulties", faction: "Trade Guild", reputation: "Respected" },
      antagonist: { name: "Troublemakers", type: "bandits", motivation: "Quick profit" },
      narrative: "Some troublemakers have been causing issues around ${settlement}. They've been stealing supplies and generally making life difficult.",
      objective_description: "Find the troublemakers and put a stop to their activities.",
      reward_description: "The merchant's guild offers ${reward_gold} gold for resolving this problem.",
      narrative_hooks: ["The troublemakers seem organized", "Some locals are secretly helping them"],
      complications: "The troublemakers might have legitimate grievances worth considering."
    }];
  }

  _getModerateTemplates() {
    return [{
      protagonist: { name: "Town Official", description: "A respected community leader", faction: "Town Council", reputation: "Authority" },
      antagonist: { name: "Organized Threat", type: "cultists", motivation: "Ideological goals" },
      narrative: "An organized group has been operating in the area around ${settlement}, causing significant problems that threaten community stability.",
      objective_description: "Investigate the group's activities and neutralize the threat they pose.",
      reward_description: "The town council has authorized a reward of ${reward_gold} gold for success.",
      narrative_hooks: ["The group has inside supporters", "Their goals are unclear but dangerous"],
      complications: "The group's members might include people you know or sympathize with."
    }];
  }

  _getHardTemplates() {
    return [{
      protagonist: { name: "Military Commander", description: "An experienced officer dealing with serious threats", faction: "Military", reputation: "Feared" },
      antagonist: { name: "Dangerous Organization", type: "mercenaries", motivation: "Wealth and power" },
      narrative: "A dangerous organization has established itself near ${settlement}, posing a serious threat to regional security.",
      objective_description: "Confront and dismantle the organization's operations in the area.",
      reward_description: "A bounty of ${reward_gold} gold has been placed on resolving this situation.",
      narrative_hooks: ["The organization has powerful backers", "Previous attempts have failed"],
      complications: "The organization's defeat could create a power vacuum with unintended consequences."
    }];
  }

  _getDeadlyTemplates() {
    return [{
      protagonist: { name: "Royal Agent", description: "An elite operative dealing with existential threats", faction: "Crown", reputation: "Legendary" },
      antagonist: { name: "Mortal Threat", type: "monsters", motivation: "Destruction or domination" },
      narrative: "A truly dangerous threat has emerged near ${settlement}, one that could devastate the entire region if not stopped.",
      objective_description: "Eliminate the threat completely, using any means necessary.",
      reward_description: "The crown offers ${reward_gold} gold and royal favor for success.",
      narrative_hooks: ["The threat has already claimed many lives", "Time is running out"],
      complications: "Success might require sacrifices you're not prepared to make."
    }];
  }

  _fillTemplateWithConstraints(template, constraints) {
    const filled = JSON.parse(JSON.stringify(template));
    
    // Replace all placeholders with actual constraint values
    let narrative = filled.narrative.replace('${settlement}', constraints.settlement_type);
    narrative = narrative.replace('${reward_gold}', constraints.reward_gold);
    filled.narrative = narrative;
    
    let rewardDesc = filled.reward_description.replace('${reward_gold}', constraints.reward_gold);
    filled.reward_description = rewardDesc;
    
    // Update antagonist based on actual enemy types
    if (constraints.enemy_types.length > 0) {
      filled.antagonist.type = constraints.enemy_types[0];
    }
    
    return filled;
  }

  _generateStepNarratives(constraints, filledTemplate) {
    const steps = [];
    const stepCount = constraints.complexity === 'single' ? 1 : 
                     constraints.complexity === 'short' ? this.constraintEngine.rng.next(2, 3) :
                     constraints.complexity === 'medium' ? this.constraintEngine.rng.next(4, 6) : 3;

    for (let i = 0; i < stepCount; i++) {
      steps.push({
        step_id: `step_${i + 1}`,
        narrative: `Step ${i + 1}: ${filledTemplate.narrative}`,
        objective: i === 0 ? filledTemplate.objective_description : `Continue working toward the main objective`
      });
    }

    return steps;
  }

  _generateChoiceConsequences(constraints) {
    const consequences = [];
    const stepCount = constraints.complexity === 'single' ? 1 : 
                     constraints.complexity === 'short' ? this.constraintEngine.rng.next(2, 3) :
                     constraints.complexity === 'medium' ? this.constraintEngine.rng.next(4, 6) : 3;

    for (let step = 1; step <= stepCount; step++) {
      const choiceCount = this.constraintEngine.rng.next(2, 3);
      for (let choice = 1; choice <= choiceCount; choice++) {
        consequences.push({
          choice_id: `choice_${step}_${choice}`,
          consequence: `This choice leads to different developments in the quest.`
        });
      }
    }

    return consequences;
  }
}
// =============================================================================
// COMPLETE QUEST SYSTEM WITH DEEPSEEK INTEGRATION
// =============================================================================

class QuestSystem {
  constructor(seed = null, deepSeekApiKey = null) {
    this.constraintEngine = new QuestConstraintEngine(seed);
    this.deepSeek = new DeepSeekIntegration(deepSeekApiKey);
    this.validator = new QuestValidator();
    this.fallbackSystem = new FallbackQuestSystem(this.constraintEngine);
    this.questRegistry = new Map();
  }

  /**
   * Generate complete quest with DeepSeek narrative
   */
  async generateCompleteQuest(settlementContext, questTier = 'random') {
    try {
      // Phase 1: Generate quest template with constraints
      const template = this._generateQuestTemplate(settlementContext, questTier);
      
      // Phase 2: Get DeepSeek narrative
      const narrativeResult = await this._getQuestNarrative(template);
      
      // Phase 3: Integrate narrative into quest
      const completeQuest = this._integrateNarrative(template, narrativeResult);
      
      // Store for persistence
      this.questRegistry.set(completeQuest.id, completeQuest);
      
      return {
        success: true,
        quest: completeQuest,
        used_fallback: narrativeResult.used_fallback,
        message: `Quest ${completeQuest.id} generated successfully`
      };
      
    } catch (error) {
      console.error('[QUESTSYSTEM] Error generating complete quest:', error);
      return {
        success: false,
        quest: null,
        error: error.message,
        used_fallback: false
      };
    }
  }

  /**
   * Generate quest template (moved from separate class for integration)
   */
  _generateQuestTemplate(settlementContext, questTier) {
    const constraints = this.constraintEngine.rollQuestConstraints(settlementContext, questTier);
    const structure = this._generateQuestStructure(constraints);
    
    return {
      id: constraints.id,
      tier: constraints.tier,
      status: 'available',
      constraints: constraints,
      protagonist: null,
      antagonist: null,
      narrative: null,
      objective_description: null,
      reward_description: null,
      narrative_hooks: [],
      complications: null,
      steps: structure.steps,
      current_step: 0,
      quest_giver: this._generateQuestGiverInfo(settlementContext),
      active_since: null,
      accepted_by_player: false,
      progress: { steps_completed: 0, objectives_met: {}, failure_conditions_triggered: [] },
      failure_conditions: this._generateFailureConditions(constraints),
      is_fallback: false,
      generated_at: new Date().toISOString()
    };
  }

  /**
   * Get narrative from DeepSeek or fallback
   */
  async _getQuestNarrative(template) {
    try {
      const narrativeResult = await this.deepSeek.generateQuestNarrative(template);
      
      if (narrativeResult.success) {
        // Validate the narrative response
        const validation = this.validator.validateNarrativeResponse(template, narrativeResult.narrative);
        
        if (validation.valid) {
          return {
            narrative: validation.cleaned_response,
            used_fallback: false
          };
        } else {
          console.warn('[QUESTSYSTEM] DeepSeek narrative failed validation:', validation.violations);
        }
      }
    } catch (error) {
      console.warn('[QUESTSYSTEM] DeepSeek API failed:', error.message);
    }
    
    // Fallback: Use constraint-respecting fallback narrative
    const fallbackNarrative = this.fallbackSystem.generateFallbackQuest(template.constraints);
    return {
      narrative: fallbackNarrative,
      used_fallback: true
    };
  }

  /**
   * Integrate narrative into quest template
   */
  _integrateNarrative(template, narrativeResult) {
    const quest = { ...template };
    const narrative = narrativeResult.narrative;
    
    // Fill main narrative fields
    quest.protagonist = narrative.protagonist;
    quest.antagonist = narrative.antagonist;
    quest.narrative = narrative.narrative;
    quest.objective_description = narrative.objective_description;
    quest.reward_description = narrative.reward_description;
    quest.narrative_hooks = narrative.narrative_hooks;
    quest.complications = narrative.complications;
    quest.is_fallback = narrativeResult.used_fallback;
    
    // Fill quest giver from protagonist
    quest.quest_giver.name = narrative.protagonist.name;
    quest.quest_giver.description = narrative.protagonist.description;
    quest.quest_giver.faction = narrative.protagonist.faction;
    quest.quest_giver.reputation = narrative.protagonist.reputation;
    
    // Fill step narratives and choices
    if (narrative.step_narratives) {
      this._integrateStepNarratives(quest, narrative.step_narratives);
    }
    
    if (narrative.choice_consequences) {
      this._integrateChoiceConsequences(quest, narrative.choice_consequences);
    }
    
    return quest;
  }

  _integrateStepNarratives(quest, stepNarratives) {
    for (const stepNarrative of stepNarratives) {
      const step = quest.steps.find(s => s.id === stepNarrative.step_id);
      if (step) {
        step.narrative = stepNarrative.narrative;
        step.objective = stepNarrative.objective;
      }
    }
  }

  _integrateChoiceConsequences(quest, choiceConsequences) {
    for (const consequence of choiceConsequences) {
      for (const step of quest.steps) {
        const choice = step.choices.find(c => c.id === consequence.choice_id);
        if (choice) {
          choice.consequences = [consequence.consequence];
        }
      }
    }
  }

  // ... (rest of helper methods from previous implementation)
  _generateQuestStructure(constraints) {
    const complexity = QUEST_CONFIG.COMPLEXITY_TYPES[constraints.complexity];
    let stepCount = Array.isArray(complexity.steps) ? 
      this.constraintEngine.rng.next(complexity.steps[0], complexity.steps[1]) : complexity.steps;

    const steps = [];
    for (let i = 0; i < stepCount; i++) {
      steps.push({
        id: `step_${i + 1}`,
        narrative: null,
        objective: null,
        completion_condition: null,
        choices: i < stepCount - 1 ? this._generateStepChoices(i, stepCount) : [],
        failure_triggers: this._generateStepFailureTriggers(constraints, i)
      });
    }

    return { steps, total_steps: stepCount };
  }

  _generateStepChoices(currentStep, totalSteps) {
    const choices = [];
    const choiceCount = this.constraintEngine.rng.next(2, 3);
    
    for (let i = 0; i < choiceCount; i++) {
      choices.push({
        id: `choice_${currentStep + 1}_${i + 1}`,
        description: null,
        leads_to_step: `step_${this.constraintEngine.rng.next(currentStep + 1, totalSteps)}`,
        consequences: []
      });
    }
    
    return choices;
  }

  _generateStepFailureTriggers(constraints, stepIndex) {
    const triggers = [];
    const triggerCount = this.constraintEngine.rng.next(1, 2);
    const triggerTypes = [
      { type: 'observability', description: 'You are spotted by someone you shouldn\'t be seen by' },
      { type: 'innocence', description: 'You harm an innocent person during this step' },
      { type: 'destruction', description: 'You destroy something important unintentionally' },
      { type: 'moral_choice', description: 'You choose a morally questionable path' }
    ];
    
    for (let i = 0; i < triggerCount; i++) {
      const trigger = this.constraintEngine.rng.choice(triggerTypes);
      triggers.push({
        ...trigger,
        id: `failure_${stepIndex + 1}_${i + 1}`,
        step: stepIndex + 1,
        consequence: this._rollFailureConsequence()
      });
    }
    
    return triggers;
  }

  _rollFailureConsequence() {
    const roll = this.constraintEngine.rng.random();
    if (roll < 0.4) return 'permanent_failure';
    if (roll < 0.7) return 'escalated_difficulty';
    return 'redemption_available';
  }

  _generateFailureConditions(constraints) {
    const conditions = [];
    const conditionCount = this.constraintEngine.rng.next(2, 3);
    const conditionTypes = [
      { type: 'npc_death', description: 'The quest giver dies before quest completion', consequence: 'permanent_failure' },
      { type: 'objective_destruction', description: 'The quest objective is destroyed or becomes unavailable', consequence: 'permanent_failure' },
      { type: 'time_sensitive', description: 'The situation resolves itself without player intervention', consequence: 'permanent_failure' },
      { type: 'reputation_loss', description: 'Player reputation falls below acceptable threshold', consequence: 'escalated_difficulty' }
    ];
    
    for (let i = 0; i < conditionCount; i++) {
      const condition = this.constraintEngine.rng.choice(conditionTypes);
      conditions.push({ ...condition, id: `global_failure_${i + 1}`, triggered: false });
    }
    
    return conditions;
  }

  _generateQuestGiverInfo(settlementContext) {
    const npcTypes = {
      hamlet: ['farmer', 'elder', 'healer', 'hunter'],
      village: ['merchant', 'blacksmith', 'priest', 'mayor', 'guard_captain'],
      town: ['noble', 'scholar', 'mage', 'guild_master', 'official'],
      city: ['aristocrat', 'archmage', 'general', 'council_member', 'crime_lord']
    };
    
    const availableTypes = npcTypes[settlementContext.type] || npcTypes.town;
    return {
      settlement_id: settlementContext.id,
      npc_type: this.constraintEngine.rng.choice(availableTypes),
      name: null,
      description: null,
      faction: null,
      reputation: null
    };
  }

  // ... (existing utility methods)
  getQuest(questId) { return this.questRegistry.get(questId); }
  getAllQuests() { return Array.from(this.questRegistry.values()); }
  loadQuests(quests) { quests.forEach(q => this.questRegistry.set(q.id, q)); }
  checkSettlementQuestAvailability(settlementType) {
    const range = QUEST_CONFIG.SETTLEMENT_QUEST_PROBABILITY[settlementType];
    if (!range) return 0;
    const probability = this.constraintEngine.rng.random() * (range.max - range.min) + range.min;
    return Math.min(1, Math.max(0, probability));
  }
}

// =============================================================================
// QUEST VALIDATOR (UPDATED FOR COMPLETE NARRATIVE VALIDATION)
// =============================================================================

class QuestValidator {
  validateNarrativeResponse(questTemplate, deepSeekResponse) {
    const violations = [];
    const constraints = questTemplate.constraints;

    // 1. Validate JSON structure includes new fields
    if (!this._validateCompleteJSONStructure(deepSeekResponse)) {
      violations.push('INVALID_JSON_STRUCTURE');
      return { valid: false, violations };
    }

    // 2. Check for forbidden keywords
    const keywordViolations = this._checkForbiddenKeywords(
      this._extractAllText(deepSeekResponse), 
      constraints.forbidden_keywords
    );
    violations.push(...keywordViolations);

    // 3. Validate reward consistency
    if (this._checkRewardMention(deepSeekResponse, constraints.reward_gold)) {
      violations.push('REWARD_AMOUNT_MENTIONED');
    }

    // 4. Validate enemy type constraints
    const enemyViolations = this._checkEnemyTypes(
      this._extractAllText(deepSeekResponse),
      constraints.enemy_types
    );
    violations.push(...enemyViolations);

    // 5. Validate narrative scope
    if (this._checkNarrativeScope(deepSeekResponse, constraints.difficulty)) {
      violations.push('NARRATIVE_SCOPE_VIOLATION');
    }

    // 6. Validate required fields
    const fieldViolations = this._checkRequiredFields(deepSeekResponse);
    violations.push(...fieldViolations);

    // 7. Validate step narratives match quest structure
    const stepViolations = this._validateStepNarratives(deepSeekResponse, questTemplate);
    violations.push(...stepViolations);

    return {
      valid: violations.length === 0,
      violations: violations.filter(v => v !== null),
      cleaned_response: this._cleanCompleteResponse(deepSeekResponse)
    };
  }

  _validateCompleteJSONStructure(response) {
    const requiredFields = [
      'protagonist', 'antagonist', 'narrative', 
      'objective_description', 'reward_description',
      'narrative_hooks', 'complications', 'step_narratives', 'choice_consequences'
    ];

    if (typeof response !== 'object' || response === null) return false;

    for (const field of requiredFields) {
      if (!(field in response)) return false;
    }

    return Array.isArray(response.narrative_hooks) && 
           Array.isArray(response.step_narratives) && 
           Array.isArray(response.choice_consequences);
  }

  _extractAllText(response) {
    const textFields = [
      response.narrative,
      response.objective_description,
      response.reward_description,
      response.complications,
      ...response.narrative_hooks,
      ...response.step_narratives.map(s => s.narrative + ' ' + s.objective),
      ...response.choice_consequences.map(c => c.consequence)
    ].join(' ').toLowerCase();

    return textFields;
  }

  _checkForbiddenKeywords(text, forbiddenKeywords) {
    const violations = [];
    for (const keyword of forbiddenKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        violations.push(`FORBIDDEN_KEYWORD: ${keyword}`);
      }
    }
    return violations;
  }

  _checkRewardMention(response, expectedReward) {
    const rewardText = response.reward_description.toLowerCase();
    const rewardPattern = /\b(\d+)\s*(gold|coin|reward|payment)\b/gi;
    const matches = [...rewardText.matchAll(rewardPattern)];
    
    for (const match of matches) {
      const mentionedAmount = parseInt(match[1]);
      if (mentionedAmount !== expectedReward) return true;
    }
    return false;
  }

  _checkEnemyTypes(text, allowedEnemyTypes) {
    const violations = [];
    const allAllowedEnemies = Object.values(QUEST_CONFIG.ALLOWED_ENEMY_TYPES).flat();
    const mentionedEnemies = allAllowedEnemies.filter(enemy => 
      text.includes(enemy.toLowerCase())
    );

    for (const mentionedEnemy of mentionedEnemies) {
      if (!allowedEnemyTypes.includes(mentionedEnemy)) {
        violations.push(`UNAPPROVED_ENEMY_TYPE: ${mentionedEnemy}`);
      }
    }
    return violations;
  }

  _checkNarrativeScope(response, difficulty) {
    const text = this._extractAllText(response);
    const scopeIndicators = {
      trivial: ['epic', 'world-saving', 'legendary', 'prophecy'],
      easy: ['kingdom', 'nation', 'great war', 'army'],
      moderate: ['region', 'many villages', 'large scale'],
      hard: ['city-wide', 'major threat', 'dangerous'],
      deadly: ['deadly', 'mortal danger', 'supreme risk']
    };

    for (const [tier, indicators] of Object.entries(scopeIndicators)) {
      const tierIndex = Object.keys(scopeIndicators).indexOf(tier);
      const currentTierIndex = Object.keys(scopeIndicators).indexOf(difficulty);
      
      if (tierIndex > currentTierIndex) {
        for (const indicator of indicators) {
          if (text.includes(indicator)) return true;
        }
      }
    }
    return false;
  }

  _checkRequiredFields(response) {
    const violations = [];
    const requiredFields = {
      protagonist: 'object',
      antagonist: 'object', 
      narrative: 'string',
      objective_description: 'string',
      reward_description: 'string',
      narrative_hooks: 'array',
      complications: 'string',
      step_narratives: 'array',
      choice_consequences: 'array'
    };

    for (const [field, type] of Object.entries(requiredFields)) {
      if (!response[field]) {
        violations.push(`MISSING_FIELD: ${field}`);
      } else if (type === 'string' && response[field].trim().length === 0) {
        violations.push(`EMPTY_FIELD: ${field}`);
      } else if (type === 'array' && response[field].length === 0) {
        violations.push(`EMPTY_ARRAY: ${field}`);
      } else if (type === 'object' && Object.keys(response[field]).length === 0) {
        violations.push(`EMPTY_OBJECT: ${field}`);
      }
    }
    return violations;
  }

  _validateStepNarratives(response, questTemplate) {
    const violations = [];
    
    // Check if step narratives match expected structure
    if (response.step_narratives.length !== questTemplate.steps.length) {
      violations.push(`STEP_COUNT_MISMATCH: Expected ${questTemplate.steps.length}, got ${response.step_narratives.length}`);
    }

    // Check if all step IDs are valid
    const expectedStepIds = questTemplate.steps.map(s => s.id);
    for (const stepNarrative of response.step_narratives) {
      if (!expectedStepIds.includes(stepNarrative.step_id)) {
        violations.push(`INVALID_STEP_ID: ${stepNarrative.step_id}`);
      }
    }

    return violations;
  }

  _cleanCompleteResponse(response) {
    const cleaned = { ...response };
    
    // Trim all string fields
    for (const key in cleaned) {
      if (typeof cleaned[key] === 'string') {
        cleaned[key] = cleaned[key].trim();
      }
    }
    
    // Clean arrays
    if (Array.isArray(cleaned.narrative_hooks)) {
      cleaned.narrative_hooks = cleaned.narrative_hooks
        .filter(hook => typeof hook === 'string')
        .map(hook => hook.trim())
        .filter(hook => hook.length > 0);
    }
    
    if (Array.isArray(cleaned.step_narratives)) {
      cleaned.step_narratives = cleaned.step_narratives
        .filter(step => step && typeof step.narrative === 'string')
        .map(step => ({
          step_id: step.step_id,
          narrative: step.narrative.trim(),
          objective: step.objective ? step.objective.trim() : ''
        }));
    }
    
    if (Array.isArray(cleaned.choice_consequences)) {
      cleaned.choice_consequences = cleaned.choice_consequences
        .filter(choice => choice && typeof choice.consequence === 'string')
        .map(choice => ({
          choice_id: choice.choice_id,
          consequence: choice.consequence.trim()
        }));
    }
    
    return cleaned;
  }
}

// =============================================================================
// FILE COMPLETE - PHASE 3B READY
// =============================================================================

module.exports = {
  QuestSystem,
  QuestConstraintEngine,
  DeepSeekIntegration,
  QuestValidator,
  FallbackQuestSystem,
  QUEST_CONFIG
};
