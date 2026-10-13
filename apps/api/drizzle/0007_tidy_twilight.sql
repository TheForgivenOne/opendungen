UPDATE `scenarios` SET `ai_instructions` = 'Tone: grim, grounded, low-magic. The world is dangerous and uncaring. Describe injuries, hunger, and exhaustion honestly. NPCs are wary of strangers. Magic is rare and feared.' WHERE `id` = 'builtin-fantasy-waystation';
--> statement-breakpoint
UPDATE `scenarios` SET `ai_instructions` = 'Tone: tense, claustrophobic, technical. Describe ship systems, sounds, and readouts concretely. NPCs are professionals under stress. No deus ex machina. Tech follows consistent rules.' WHERE `id` = 'builtin-scifi-derelict';
--> statement-breakpoint
UPDATE `scenarios` SET `ai_instructions` = 'Tone: quiet, unsettling, 1970s. Period details should feel lived in, not nostalgic. NPCs lie for small, human reasons. Clues are concrete (objects, timelines, contradictions). Do not introduce supernatural elements.' WHERE `id` = 'builtin-mystery-hollow-creek';
