## ServiceNow Coding Standards

### ⚠️ CRITICAL: Scoped Application API Restrictions

**In scoped applications (like Service Portal widgets), certain global APIs are NOT allowed:**

```javascript
// ❌ INCORRECT - NOT allowed in scoped apps
var now = new GlideDateTime();
now.setDisplayValue(gs.nowDateTime());  // ERROR: Function nowDateTime is not allowed in scope!

// ✅ CORRECT - Use GlideDateTime constructor directly
var now = new GlideDateTime();  // Automatically initializes to current time
data.currentDay = parseInt(now.getDayOfMonthLocalTime());
data.currentMonth = parseInt(now.getMonthLocalTime());
data.currentYear = parseInt(now.getYearLocalTime());
data.dayOfWeek = now.getDayOfWeekLocalTime();
```

**Key Rules:**
- ✅ `new GlideDateTime()` - Creates current date/time automatically
- ✅ Use `LocalTime` methods: `getDayOfMonthLocalTime()`, `getMonthLocalTime()`, `getYearLocalTime()`
- ❌ `gs.nowDateTime()` - NOT allowed in scoped applications
- ❌ `gs.now()` - NOT allowed in scoped applications
- ❌ Non-LocalTime methods may fail: `getDayOfMonth()`, `getMonth()`, `getYear()`

### Service Portal Widget Client Scripts

**Use Angular dependency injection, not IIFE patterns:**

```javascript
// ❌ WRONG - IIFE loses 'this' context, causes $apply issues
(function() {
  var c = this;
  setInterval(function() { c.$apply(); }, 1000);
})();

// ✅ CORRECT - Proper Angular controller with DI
api.controller = function($scope, $interval, $timeout) {
  var c = this;
  $interval(updateFn, 1000);  // Auto-handles digest cycle
};
```

**Available Angular services:** `$scope`, `$interval`, `$timeout`, `$http`, `$q`, `$location`, `spUtil`, `spModal`

### GlideRecord Best Practices
Always use `setValue()` and `getValue()` methods:

```javascript
// ✅ CORRECT
var grUser = new GlideRecord('sys_user');
if (grUser.get(userId)) {
    var userName = grUser.getValue('name');
    grUser.setValue('active', true);
    grUser.update();
}

// ❌ INCORRECT
var gr = new GlideRecord('sys_user');
if (gr.get(userId)) {
    var userName = gr.name;  // Direct property access
    gr.active = true;        // Direct property assignment
    gr.update();
}
```

### Variable Naming
Use semantic variable names with prefixes:
- `grUser` - GlideRecord for user
- `grIncident` - GlideRecord for incident
- `gaRecords` - GlideAggregate
- Not just `gr` or `ga`
