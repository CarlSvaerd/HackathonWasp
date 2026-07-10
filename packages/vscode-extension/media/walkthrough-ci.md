# Add The CI Gate

Once local review feels right, generate the team workflow.

[Add GitHub Actions Gate](command:ghostTestCatcher.addGitHubActionsGate)

The generated workflow runs `ghost-test-catcher ci`, writes a Markdown summary, uploads the JSON report, and can fail pull requests when tests are ghost-risk or need review depending on the policy you choose.

