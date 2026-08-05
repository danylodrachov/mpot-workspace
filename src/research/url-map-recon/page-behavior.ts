// Page behavior profiler — documents rendering type, interactive elements,
// content loading patterns, and navigation structure on casino pages.
//
// This module provides utilities to validate and write page-behavior.json.
// The discovery-browser agent uses these to persist behavior profiles.

import { writeFileSync } from 'node:fs';
import type { PageBehaviorProfile, BehaviorSection, BehaviorSectionResult } from './types.ts';

export function validatePageBehavior(profile: PageBehaviorProfile): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!profile.casino_id || typeof profile.casino_id !== 'string') {
    errors.push('casino_id is required and must be a string');
  }

  if (!profile.geo || typeof profile.geo !== 'string' || profile.geo.length !== 2) {
    errors.push('geo must be a 2-character country code');
  }

  if (!profile.locale || typeof profile.locale !== 'string') {
    errors.push('locale is required (e.g., pt-BR, de-AT)');
  }

  if (!profile.profiled_at || typeof profile.profiled_at !== 'string') {
    errors.push('profiled_at is required (ISO 8601 timestamp)');
  }

  if (profile.landing) {
    if (!profile.landing.url || typeof profile.landing.url !== 'string') {
      errors.push('landing.url must be a valid URL string');
    }

    if (profile.landing.gates) {
      for (const gate of profile.landing.gates) {
        if (!gate.type || !gate.trigger || !gate.dismiss) {
          errors.push('Each gate must have type, trigger, and dismiss fields');
        }
      }
    }
  }

  if (profile.sections) {
    for (const [sectionKey, section] of Object.entries(profile.sections)) {
      if ('status' in section) {
        // This is an error section - must have both status and reason
        const s = section as any;
        if (!['human_required', 'blocked', 'absent'].includes(s.status)) {
          errors.push(`Section ${sectionKey}: invalid status "${s.status}"`);
        }
        if (!s.reason || typeof s.reason !== 'string') {
          errors.push(`Section ${sectionKey}: reason must be a non-empty string`);
        }
      } else {
        // This is a full section behavior
        const s = section as any;
        if (!s.url || typeof s.url !== 'string') {
          errors.push(`Section ${sectionKey}: url is required`);
        }
        if (!s.rendering || typeof s.rendering !== 'string') {
          errors.push(`Section ${sectionKey}: rendering type is required`);
        }
        if (!s.content_structure || typeof s.content_structure !== 'string') {
          errors.push(`Section ${sectionKey}: content_structure is required`);
        }
        if (!s.collection || typeof s.collection !== 'object') {
          errors.push(`Section ${sectionKey}: collection is required`);
        } else {
          if (!s.collection.type || typeof s.collection.type !== 'string') {
            errors.push(`Section ${sectionKey}: collection.type is required`);
          }
          if (typeof s.collection.visible_count !== 'number' || s.collection.visible_count < 0) {
            errors.push(`Section ${sectionKey}: collection.visible_count must be a non-negative number`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function writePageBehavior(profile: PageBehaviorProfile, outputPath: string): void {
  const validation = validatePageBehavior(profile);
  if (!validation.valid) {
    throw new Error(`Invalid page behavior profile: ${validation.errors.join('; ')}`);
  }

  writeFileSync(outputPath, JSON.stringify(profile, null, 2));
}

export function readPageBehaviorPartial(sections: Record<BehaviorSection, BehaviorSectionResult>): PageBehaviorProfile {
  // Helper to construct a minimal profile from sections (used in tests)
  return {
    casino_id: 'test-casino',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: new Date().toISOString(),
    sections,
  };
}
