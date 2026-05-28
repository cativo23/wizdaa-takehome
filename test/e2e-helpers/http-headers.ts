export function asEmployee(empId: string): Record<string, string> {
  return { 'X-Employee-Id': empId, 'X-Role': 'employee' };
}

export function asManager(mgrId = 'mgr1'): Record<string, string> {
  return { 'X-Employee-Id': mgrId, 'X-Role': 'manager' };
}
