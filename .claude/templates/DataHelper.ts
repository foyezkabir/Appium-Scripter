import { faker } from '@faker-js/faker';

/**
 * Test data that is REALISTIC and UNIQUE at the same time.
 *
 * WHEN TO USE THIS, AND WHEN NOT TO:
 *
 *   FIXED literal — the value is the app's own vocabulary and the test asserts
 *   AGAINST it: blood groups, column headings, consultation types, expected
 *   copy, a deliberately malformed string whose exact shape is the point.
 *   Generating these would be nonsense.
 *
 *   GENERATED (here) — the value is INPUT the app will store, validate or show
 *   back: a name typed into a form, an email that must not match any account, a
 *   password that must never authenticate.
 *
 *   ENV VAR — the value must be a real account or a real phone the team owns.
 *   A generated Bangladeshi number is a STRANGER'S real phone.
 *
 * Why generated beats a literal for the second category, on a PRODUCTION target:
 * a hardcoded "not.a.real.user@..." can be registered by someone one day, and
 * the test that asserted "unknown account is rejected" then silently asserts
 * nothing. Same for a hardcoded wrong password.
 */
export class DataHelper {
  /** A value no earlier run will reproduce. Time part keeps it ordered and
   *  readable; random part survives two calls in the same millisecond. */
  static uid(): string {
    return `${Date.now().toString(36)}-${faker.string.alphanumeric(6)}`;
  }

  /** Shorter suffix for appending to human-readable text. */
  static tag(): string {
    return `${Date.now().toString(36).slice(-4)}${faker.string.alphanumeric(4)}`;
  }

  /** A real-looking person name: "Ewald Walter 04e0sedj". Realistic matters —
   *  it exercises the same validation and layout a real name does. */
  static personName(): string {
    return `${faker.person.fullName()} ${DataHelper.tag()}`;
  }

  /** A deliverable-looking but unique address. Defaults to a reserved TLD that
   *  can never be a real inbox. */
  static email(domain = 'example.test'): string {
    let local = faker.internet.username().toLowerCase().replace(/[^a-z0-9.]/g, '');
    return `qa.${local}.${DataHelper.tag()}@${domain}`;
  }

  /** A numeric reference / registration / OTP of a given length. */
  static numericId(length = 10): string {
    return faker.string.numeric(length);
  }

  /** A local-format mobile number. NEVER use this where an SMS is actually
   *  sent — the number belongs to a real person. */
  static phone(prefix = '01', operators = ['3', '4', '5', '6', '7', '8', '9'], digits = 8): string {
    return `${prefix}${faker.helpers.arrayElement(operators)}${faker.string.numeric(digits)}`;
  }

  /** A display name that is obviously test data, for rows a human will see.
   *  QA-AUTO = made through the UI, QA-SEED = seeded through the API. */
  static unique(label: string, prefix = 'QA-AUTO'): string {
    return `${prefix} ${label} ${DataHelper.uid()}`;
  }
}
