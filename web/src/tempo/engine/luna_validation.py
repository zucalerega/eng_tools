"""Conservative static checks against Luna's public PyO3 API contract.

Unknown/dynamic types are deliberately left for simulated runtime validation;
we only reject calls when their static incompatibility can be demonstrated.
"""

import ast
import math

from luna_contract import COMMON_EXPORTS, CONSTRUCTORS, FUNCTIONS, METHODS, OTHER_CLASSES, UNIT_CLASSES, UNIT_CONSTANTS, VALVE_STATES, SENSOR_COMPARISON_ORDER


def issue(message, node, severity="error", stage="api"):
    return {"stage": stage, "severity": severity, "message": message,
            "line": getattr(node, "lineno", 0), "column": getattr(node, "col_offset", -1) + 1}


def literal_integer(node):
    if isinstance(node, ast.Constant) and type(node.value) is int:
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = literal_integer(node.operand)
        if value is not None:
            return -value if isinstance(node.op, ast.USub) else value
    return None


def validate_abort_expression(expression, valves, sensors, node):
    """Validate an expression in the *separate* Luna abort worker's namespace."""
    problems = []
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        return None, [issue(f"Invalid abort condition: {exc.msg}", node)]
    available = set(valves) | set(sensors) | set(UNIT_CONSTANTS) | {
        "True", "False", "None", "abs", "min", "max", "round", "int", "float", "bool",
        "OPEN", "CLOSED", "ValveState", "read_umbilical_voltage", "reco_recvd_launch",
        "curr_abort_stage", "curr_abort_condition", "aborted_in_this_stage",
    }
    allowed_nodes = (
        ast.Expression, ast.BoolOp, ast.BinOp, ast.UnaryOp, ast.Compare,
        ast.Call, ast.Attribute, ast.Name, ast.Load, ast.Constant,
        ast.And, ast.Or, ast.Not, ast.Add, ast.Sub, ast.Mult, ast.Div,
        ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Eq, ast.NotEq,
        ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Is, ast.IsNot,
    )
    for item in ast.walk(tree):
        if not isinstance(item, allowed_nodes):
            problems.append(issue(f"Abort expression uses unsupported construct: {type(item).__name__}", node))
            break
        if isinstance(item, ast.Name) and item.id not in available:
            problems.append(issue(f"Abort condition references '{item.id}', which is unavailable in Luna's separate abort process", node))
        if isinstance(item, ast.Attribute):
            if not (isinstance(item.value, ast.Name) and item.value.id in valves and item.attr in {"is_open", "is_closed"}) and not (
                isinstance(item.value, ast.Name) and item.value.id in sensors and item.attr == "read"
            ) and not (isinstance(item.value, ast.Name) and item.value.id == "ValveState" and item.attr in VALVE_STATES):
                problems.append(issue(f"Unsupported attribute '.{item.attr}' in abort condition", node))
        if isinstance(item, ast.Call):
            allowed_builtin = isinstance(item.func, ast.Name) and item.func.id in {
                "abs", "min", "max", "round", "int", "float", "bool"
            }
            allowed_readonly = isinstance(item.func, ast.Name) and item.func.id in {
                "read_umbilical_voltage", "reco_recvd_launch", "curr_abort_stage",
                "curr_abort_condition", "aborted_in_this_stage",
            } and not item.args and not item.keywords
            allowed_device = isinstance(item.func, ast.Attribute) and isinstance(item.func.value, ast.Name) and (
                (item.func.value.id in sensors and item.func.attr == "read") or
                (item.func.value.id in valves and item.func.attr in {"is_open", "is_closed"})
            ) and not item.args and not item.keywords
            if not (allowed_builtin or allowed_device or allowed_readonly):
                problems.append(issue("Abort condition can only call sensor reads, valve state checks, or safe numeric builtins", node))
    return (compile(tree, "<abort_condition>", "eval") if not problems else None), problems


class LunaApiChecker(ast.NodeVisitor):
    def __init__(self, valves, sensors):
        self.valves = valves
        self.sensors = sensors
        self.errors = []
        self.types = {name: f"quantity:{kind}" for name, kind in UNIT_CONSTANTS.items()}
        self.types.update({name: "valve" for name in valves})
        self.types.update({name: f"sensor:{data['unit']}" for name, data in sensors.items()})
        self.types.update({"OPEN": "valvestate", "CLOSED": "valvestate"})
        self.common_modules = {"common"}
        self.aliases = {}
        self.call_aliases = {}
        self.shadowed = set()

    def constant_number(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.Name) and node.id in {"s", "ms", "us"}:
            return {"s": 1, "ms": .001, "us": .000001}[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            value = self.constant_number(node.operand)
            return None if value is None else -value if isinstance(node.op, ast.USub) else value
        if isinstance(node, ast.BinOp):
            a, b = self.constant_number(node.left), self.constant_number(node.right)
            if a is not None and b is not None:
                try:
                    if isinstance(node.op, ast.Mult): return a * b
                    if isinstance(node.op, ast.Div): return a / b
                    if isinstance(node.op, ast.Add): return a + b
                    if isinstance(node.op, ast.Sub): return a - b
                except (ArithmeticError, OverflowError): return math.inf
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and len(node.args) == 1:
            if node.func.id == "Duration": return self.constant_number(node.args[0])
            if node.func.id == "float" and isinstance(node.args[0], ast.Constant):
                try: return float(node.args[0].value)
                except (ValueError, TypeError): pass
        return None

    def record(self, message, node, severity="error"):
        self.errors.append(issue(message, node, severity))

    def type_of(self, node):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool):
                return "bool"
            if isinstance(node.value, str):
                return "str"
            if isinstance(node.value, int):
                return "int"
            if isinstance(node.value, float):
                return "float"
            if node.value is None:
                return "none"
        if isinstance(node, ast.Name):
            if node.id in ("True", "False"):
                return "bool"
            return self.types.get(node.id, "unknown")
        if isinstance(node, (ast.Lambda, ast.GeneratorExp)):
            return "callable" if isinstance(node, ast.Lambda) else "unknown"
        if isinstance(node, ast.Dict):
            return "dict"
        if isinstance(node, ast.Tuple):
            return "tuple"
        if isinstance(node, ast.List):
            return "list"
        if isinstance(node, (ast.Compare, ast.BoolOp)):
            return "bool"
        if isinstance(node, ast.UnaryOp):
            return "bool" if isinstance(node.op, ast.Not) else self.type_of(node.operand)
        if isinstance(node, ast.BinOp):
            left, right = self.type_of(node.left), self.type_of(node.right)
            if isinstance(node.op, (ast.Add, ast.Sub)):
                return left if left == right else "unknown"
            if isinstance(node.op, (ast.Mult, ast.Div)):
                if left.startswith("quantity:") and right in {"int", "float"}:
                    return left
                if isinstance(node.op, ast.Mult) and right.startswith("quantity:") and left in {"int", "float"}:
                    return right
            return "float" if left in {"int", "float"} and right in {"int", "float"} else "unknown"
        if isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id == "ValveState":
                return "valvestate" if node.attr in VALVE_STATES else "unknown"
        if isinstance(node, ast.Call):
            name, owner = self.call_target(node.func)
            if owner in {"Valve", "Sensor"}:
                if name == "read" and owner == "Sensor" and isinstance(node.func.value, ast.Name):
                    kind = self.types.get(node.func.value.id, "unknown")
                    return "float" if kind == "sensor:unknown" else kind.replace("sensor:", "quantity:")
                return "bool" if name in {"is_open", "is_closed"} else "unknown"
            if name in CONSTRUCTORS and owner is None:
                if name in UNIT_CLASSES:
                    return f"quantity:{UNIT_CLASSES[name]}"
                if name == "Valve":
                    return "valve"
                if name == "Sensor":
                    first = node.args[0] if node.args else None
                    if isinstance(first, ast.Constant) and isinstance(first.value, str):
                        unit = self.sensors.get(first.value, {}).get("unit", "unknown")
                        return f"sensor:{unit}"
                    return "sensor:unknown"
                return "unknown"
            if owner is None and name in {"reco_recvd_launch", "aborted_in_this_stage"}:
                return "bool"
            if owner is None and name in {"curr_abort_stage", "curr_abort_condition"}:
                return "str"
            if owner is None and name == "read_umbilical_voltage":
                return "quantity:V"
        return "unknown"

    def call_target(self, func):
        if isinstance(func, ast.Name):
            if func.id in self.shadowed and func.id not in self.call_aliases:
                return None, None
            if func.id in self.call_aliases:
                return self.call_aliases[func.id]
            return self.aliases.get(func.id, func.id), None
        if (isinstance(func, ast.Call) and isinstance(func.func, ast.Name) and
                func.func.id == "getattr" and len(func.args) == 2 and not func.keywords and
                isinstance(func.args[1], ast.Constant) and isinstance(func.args[1].value, str)):
            kind = self.type_of(func.args[0])
            owner = "Valve" if kind == "valve" else "Sensor" if kind.startswith("sensor:") else None
            if owner:
                return func.args[1].value, owner
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            base = func.value.id
            if base in self.common_modules:
                return func.attr, None
        if isinstance(func, ast.Attribute):
            kind = self.type_of(func.value)
            if kind == "valve":
                return func.attr, "Valve"
            if kind.startswith("sensor:"):
                return func.attr, "Sensor"
        return None, None

    def visit_Import(self, node):
        for item in node.names:
            if item.name == "common":
                self.common_modules.add(item.asname or "common")

    def visit_ImportFrom(self, node):
        if node.module == "common":
            for item in node.names:
                if item.name != "*":
                    if item.name not in COMMON_EXPORTS:
                        self.record(f"Luna's common module does not export '{item.name}'", node)
                    self.aliases[item.asname or item.name] = item.name

    def _track_assignment(self, target, value):
        if not isinstance(target, ast.Name):
            return
        if target.id in COMMON_EXPORTS or target.id in self.valves or target.id in self.sensors or target.id in self.common_modules:
            self.record("API not fully verified: injected API or module name is rebound", target, "warning")
            self.shadowed.add(target.id)
            self.common_modules.discard(target.id)
            self.aliases.pop(target.id, None)
        self.types[target.id] = self.type_of(value)
        name, owner = self.call_target(value)
        if (owner and name in METHODS[owner]) or (owner is None and name in (set(FUNCTIONS) | set(CONSTRUCTORS))):
            self.call_aliases[target.id] = (name, owner)
        else:
            self.call_aliases.pop(target.id, None)

    def visit_Assign(self, node):
        self.visit(node.value)
        for target in node.targets:
            if not isinstance(target, ast.Name):
                self.record("API not fully verified: mutable or destructured assignment target", target, "warning")
            self._track_assignment(target, node.value)

    def visit_AnnAssign(self, node):
        if node.value:
            self.visit(node.value)
            self._track_assignment(node.target, node.value)

    def visit_If(self, node):
        self.record("API not fully verified: branch-dependent bindings and unexecuted paths require review", node, "warning")
        if isinstance(node.test, ast.Constant) and not node.test.value:
            self.visit(node.test)
            start = len(self.errors)
            for item in node.body:
                self.visit(item)
            for problem in self.errors[start:]:
                problem["severity"] = "warning"
                problem["message"] = "API not fully verified: unreachable branch: " + problem["message"]
            for item in node.orelse:
                self.visit(item)
        else:
            self.generic_visit(node)

    def visit_FunctionDef(self, node):
        self.record("API not fully verified: function scope, argument bindings and unexecuted paths require review", node, "warning")
        # Do not infer a function local using a same-named outer device.
        saved = self.types.copy(), self.aliases.copy(), self.call_aliases.copy(), self.shadowed.copy(), self.common_modules.copy()
        start = len(self.errors)
        parameters = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        parameters += [arg for arg in (node.args.vararg, node.args.kwarg) if arg]
        for arg in parameters:
            self.types[arg.arg] = "unknown"
            self.shadowed.add(arg.arg)
            self.common_modules.discard(arg.arg)
            self.aliases.pop(arg.arg, None)
            self.call_aliases.pop(arg.arg, None)
        self.generic_visit(node)
        for problem in self.errors[start:]:
            if problem["severity"] == "error":
                problem["severity"] = "warning"
                problem["message"] = "API not fully verified: function body is checked only when executed: " + problem["message"]
        self.types, self.aliases, self.call_aliases, self.shadowed, self.common_modules = saved

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Lambda(self, node):
        # wait_until predicate lambdas are common; opaque lambda calls are
        # classified by their unresolved call target/argument types.
        self.generic_visit(node)

    def visit_Try(self, node):
        self.record("API not fully verified: exception-dependent paths and production error behavior require review", node, "warning")
        self.generic_visit(node)

    visit_TryStar = visit_Try

    def visit_ClassDef(self, node):
        self.record("API not fully verified: custom classes and dynamic method resolution", node, "warning")
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in {"getattr", "setattr", "delattr", "hasattr", "vars", "globals", "locals", "eval", "exec", "__import__", "type"}:
            self.record("API not fully verified: reflection or dynamic namespace access; executed simulation is not a full API check", node, "warning")
        name, owner = self.call_target(node.func)
        if name is None and owner is None and not (
                isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                and node.func.value.id in {"time", "math"}):
            self.record("API not fully verified: unresolved dynamic call target; simulation only checks executed paths", node, "warning")
        if (isinstance(node.func, ast.Name) and node.func.id == "getattr" and
                len(node.args) >= 2):
            kind = self.type_of(node.args[0])
            cls = "Valve" if kind == "valve" else "Sensor" if kind.startswith("sensor:") else None
            if kind.startswith("quantity:"):
                attr = node.args[1]
                if isinstance(attr, ast.Constant) and isinstance(attr.value, str) and not attr.value.startswith("__"):
                    self.record(f"Luna quantity classes do not expose .{attr.value}", node)
                elif not isinstance(attr, ast.Constant):
                    self.record("API not fully verified: dynamic quantity attribute access", node, "warning")
            if cls:
                attr = node.args[1]
                if isinstance(attr, ast.Constant) and isinstance(attr.value, str):
                    if attr.value not in METHODS[cls]:
                        self.record(f"{cls} does not expose .{attr.value}() in Luna's Python API", node)
                else:
                    self.record("API not fully verified: dynamic getattr() on a Luna device; "
                                "simulation only checks executed paths", node, "warning")
        if owner and name not in METHODS[owner]:
            self.record(f"{owner} does not expose .{name}() in Luna's Python API", node)
        signature = METHODS[owner].get(name) if owner and name in METHODS[owner] else None
        if owner is None:
            signature = FUNCTIONS.get(name, CONSTRUCTORS.get(name))
            if name in OTHER_CLASSES:
                self.record(f"Luna's {name} class has no public Python constructor", node)
        if signature is None and owner is None and name not in {"print", "range", "abs", "min", "max", "round", "int", "float", "bool", "str", "len", "isinstance", "list", "tuple", "dict", "set", "enumerate", "zip", "hash", "getattr", "setattr", "vars", "type"}:
            self.record("API not fully verified: unresolved named call; bindings may be dynamic", node, "warning")
        if signature is not None:
            self.check_signature(name, node, signature)
        if name in {"Valve", "Sensor"} and owner is None and node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                pool = self.valves if name == "Valve" else self.sensors
                if first.value not in pool:
                    self.record(f"API not fully verified: {name} '{first.value}' is not in the Test Environment; construction is legal but device access needs a mapping", node, "warning")
        if name == "wait_until" and owner is None:
            timeout = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "timeout"), None)
            unpacked = any(isinstance(arg, ast.Starred) for arg in node.args) or any(k.arg is None for k in node.keywords)
            if timeout is None and unpacked:
                self.record("API not fully verified: unpacked timeout is checked only on executed paths", node, "warning")
            elif timeout is None or isinstance(timeout, ast.Constant) and timeout.value is None:
                self.record("Portability policy: wait_until requires an explicit finite nonnegative timeout; upstream omitted-timeout binding panics on the tested host", node)
            elif timeout is not None:
                value = self.constant_number(timeout)
                if value is not None and (not math.isfinite(value) or value < 0 or value >= 2**64):
                    self.record("Portability policy: wait_until timeout must be finite, nonnegative and representable as a Rust Duration", timeout)
                elif value is None:
                    self.record("API not fully verified: timeout finiteness is only checked on executed paths", timeout, "warning")
        if name == "create_abort_stage" and owner is None:
            self.check_abort_config(node)
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr.startswith("_"):
            self.record("API not fully verified: private or special attribute reflection", node, "warning")
        kind = self.type_of(node.value)
        if kind == "unknown" and not (isinstance(node.value, ast.Name) and node.value.id in self.common_modules | {"time", "math", "ValveState"}):
            self.record("API not fully verified: attribute owner type is unknown", node, "warning")
        owner = "Valve" if kind == "valve" else "Sensor" if kind.startswith("sensor:") else None
        if owner and not node.attr.startswith("__") and node.attr not in METHODS[owner]:
            self.record(f"{owner} does not expose attribute .{node.attr} in Luna's Python API", node)
        if isinstance(node.value, ast.Name) and node.value.id in self.common_modules:
            if node.attr not in COMMON_EXPORTS:
                self.record(f"Luna's common module does not export '{node.attr}'", node)
        if isinstance(node.value, ast.Name) and node.value.id == "ValveState" and node.attr not in VALVE_STATES:
            self.record(f"Unknown Luna ValveState.{node.attr}", node)
        if not node.attr.startswith("__") and self.type_of(node.value).startswith("quantity:"):
            self.record("Luna's PyO3 quantity classes do not expose public quantity attributes", node)
        self.generic_visit(node)

    def visit_BinOp(self, node):
        left, right = self.type_of(node.left), self.type_of(node.right)
        if isinstance(node.op, (ast.Add, ast.Sub)) and left.startswith("quantity:") and right.startswith("quantity:") and left != right:
            self.record(f"Luna cannot combine {left[9:]} and {right[9:]} units with + or -", node)
        self.generic_visit(node)

    def visit_Compare(self, node):
        terms = [node.left, *node.comparators]
        if any(self.type_of(term).startswith("sensor:") for term in terms):
            if SENSOR_COMPARISON_ORDER == "reversed":
                self.record("Luna reverses direct Sensor comparison operands; use .read() for "
                            "the intended threshold direction", node, "warning")
        for a, b, op in zip(terms, terms[1:], node.ops):
            left, right = self.type_of(a), self.type_of(b)
            if left.startswith("sensor:"):
                left = "float" if left == "sensor:unknown" else left.replace("sensor:", "quantity:")
            if right.startswith("sensor:"):
                right = "float" if right == "sensor:unknown" else right.replace("sensor:", "quantity:")
            if not isinstance(op, (ast.Eq, ast.NotEq)) and left.startswith("quantity:") and right != "unknown" and left != right:
                self.record(f"Luna comparison mixes {left[9:]} with {right}", node)
        self.generic_visit(node)

    def check_signature(self, name, node, signature):
        if any(isinstance(arg, ast.Starred) for arg in node.args) or any(keyword.arg is None for keyword in node.keywords):
            self.record(f"API not fully verified: {name}() uses dynamic argument unpacking; simulation only checks executed paths", node, "warning")
            return
        expected = {param: kind for param, kind in signature}
        required = {param for param, kind in signature if not kind.startswith("Option<")}
        passed = {}
        if len(node.args) > len(signature):
            self.record(f"{name}() takes at most {len(signature)} argument(s), got {len(node.args)}", node)
        for (param, _), value in zip(signature, node.args):
            passed[param] = value
        for keyword in node.keywords:
            if keyword.arg not in expected:
                self.record(f"{name}() has no parameter '{keyword.arg}'", keyword)
            elif keyword.arg in passed:
                self.record(f"{name}() received '{keyword.arg}' more than once", keyword)
            else:
                passed[keyword.arg] = keyword.value
        missing = required - set(passed)
        if missing:
            self.record(f"{name}() missing required argument(s): {', '.join(sorted(missing))}", node)
        for param, value in passed.items():
            if expected[param] in {"Duration", "Option<Duration>"}:
                duration = self.constant_number(value)
                if duration is not None and (not math.isfinite(duration) or duration < 0 or duration >= 2**64):
                    self.record("Portability policy: Duration must be finite, nonnegative and representable in Rust", value)
            kind = expected[param]
            actual = self.type_of(value)
            if actual == "unknown":
                self.record("API not fully verified: argument type is unknown; simulation only checks executed paths", value, "warning")
                continue
            if kind.startswith("Option<"):
                if actual == "none":
                    continue
                kind = kind[7:-1]
            valid = {
                "Duration": {"quantity:s"}, "String": {"str"}, "bool": {"bool"},
                "&PyAny": {"callable"}, "&PyDict": {"dict"},
                "u32": {"int", "bool"}, "i64": {"int", "bool"}, "f64": {"int", "float", "bool"},
            }.get(kind)
            if valid and actual not in valid:
                self.record(f"{name}() parameter '{param}' expects {kind}, got {actual}", value)
            value_integer = literal_integer(value)
            if kind == "i64" and value_integer is not None and not -(2**63) <= value_integer < 2**63:
                self.record(f"{name}() parameter '{param}' must fit a signed 64-bit integer", value)
            if kind == "u32" and value_integer is not None and not 0 <= value_integer <= 0xFFFFFFFF:
                self.record(f"{name}() parameter '{param}' must fit an unsigned 32-bit integer", value)

    def check_abort_config(self, node):
        values = {param: arg for (param, _), arg in zip(FUNCTIONS["create_abort_stage"], node.args)}
        values.update({keyword.arg: keyword.value for keyword in node.keywords if keyword.arg})
        condition = values.get("abort_condition")
        if isinstance(condition, ast.Constant) and isinstance(condition.value, str):
            _, errors = validate_abort_expression(condition.value, self.valves, self.sensors, condition)
            self.errors.extend(errors)
        safe = values.get("safe_valve_states")
        if not isinstance(safe, ast.Dict):
            return
        for key, value in zip(safe.keys, safe.values):
            if self.type_of(key) not in ("valve", "unknown"):
                self.record("Abort safe-state key must be a Valve object", key)
            if not isinstance(value, ast.Tuple) or len(value.elts) != 2:
                self.record("Abort safe state must be (ValveState, integer milliseconds)", value)
                continue
            state, timer = value.elts
            if self.type_of(state) not in ("valvestate", "unknown"):
                self.record("Abort safe state must use OPEN, CLOSED, or ValveState", state)
            if self.type_of(timer) not in ("int", "unknown"):
                self.record("Abort safing timer must be an integer number of milliseconds, not a Duration", timer)
            delay_ms = literal_integer(timer)
            if delay_ms is not None and not 0 <= delay_ms <= 0xFFFFFFFF:
                self.record("Abort safing timer must be between 0 and 4294967295 ms", timer)


def analyze_luna_api(tree, valves, sensors):
    checker = LunaApiChecker(valves, sensors)
    checker.visit(tree)
    return checker.errors
