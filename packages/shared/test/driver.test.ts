import { describe, it, expect } from 'vitest';
import { createDriverRequestSchema, driverFullName, updateDriverRequestSchema } from '../src';

describe('driver profiles', () => {
  const bongani = {
    name: ' Bongani ',
    surname: 'Zulu',
    email: ' Bongani@Example.COM ',
    phone: '071 234 5678',
  };

  it('trims the names and lowercases the email', () => {
    expect(createDriverRequestSchema.parse(bongani)).toEqual({
      name: 'Bongani',
      surname: 'Zulu',
      email: 'bongani@example.com',
      phone: '071 234 5678',
    });
  });

  it('needs a name, surname, email and phone', () => {
    for (const field of ['name', 'surname', 'email', 'phone'] as const) {
      expect(createDriverRequestSchema.safeParse({ ...bongani, [field]: '' }).success, field).toBe(
        false,
      );
    }
    expect(createDriverRequestSchema.safeParse({ ...bongani, email: 'nope' }).success).toBe(false);
  });

  it('an edit may change one thing, or switch the profile off', () => {
    expect(updateDriverRequestSchema.safeParse({ phone: '082 555 0199' }).success).toBe(true);
    expect(updateDriverRequestSchema.safeParse({ active: false }).success).toBe(true);
  });

  it('a record names the driver as "Name Surname"', () => {
    expect(driverFullName({ name: 'Pieter', surname: 'van Wyk' })).toBe('Pieter van Wyk');
  });
});
