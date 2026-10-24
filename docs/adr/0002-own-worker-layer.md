# The worker layer is written from zero, with Sandcastle as a reference only

The worker layer is ours, behind the `WorkerRunner` interface, so that a fake runner can test the coordinator with no Docker and no plan usage, and so that the layer gives exactly what the coordinator needs: deadlines, token usage, plan-limit detection, commits and the independent verifier. Sandcastle (`mattpocock/sandcastle`) solves similar problems: we read its documentation and its code to see how it solves one before we write ours, but we do not install it, run it or copy its code.
