# story

A two-room text game in one C file. No libraries beyond the C standard.

```
gcc -Wall -Werror -o story engine.c
printf 'north\nquit\n' | ./story
```

`north` from the cell enters the hall. `south` from the cell is a wall.
