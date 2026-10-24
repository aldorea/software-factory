# Spec #42: saved searches

The base subtask adds the table and the contracts. The list and the editor then run in one wave.

```json factory-spec
{
  "files": {
    "A1": ["src/db/schema.ts", "src/search/list.ts"],
    "A2": ["src/search/list.ts"],
    "A3": ["src/search/editor.tsx"]
  },
  "base": {
    "id": "base",
    "criteria": ["A1"],
    "scope": ["src/db/", "package.json"],
    "dependsOn": [],
    "testChanges": []
  },
  "subtasks": [
    {
      "id": "list",
      "criteria": ["A2"],
      "scope": ["src/search/list.ts"],
      "dependsOn": [],
      "testChanges": ["test/search.test.ts"]
    },
    {
      "id": "editor",
      "criteria": ["A3"],
      "scope": ["src/search/editor.tsx"],
      "dependsOn": [],
      "testChanges": []
    }
  ],
  "criteria": {
    "A1": { "evidence": "request", "level": "subtask" },
    "A2": { "evidence": "playwright", "level": "integration" },
    "A3": { "evidence": "human", "level": "integration", "reason": "The layout of the editor is a visual judgement." }
  }
}
```

The editor stays out of the list because they share no file.
