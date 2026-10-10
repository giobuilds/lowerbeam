#include <stdbool.h>
#include <stdio.h>
#include <string.h>

/* Rooms are a table. An exit of -1 is a wall. */
typedef struct {
  const char *name;
  const char *text;
  int north;
  int south;
} Room;

static const Room rooms[] = {
  { "cell", "You wake in a small, dark room. A door is to the north.", 1, -1 },
  { "hall", "A short hall. The cell is to the south.", -1, 0 },
};

static int here = 0;

static void look(void) {
  printf("%s\n", rooms[here].text);
}

static void go(int next) {
  if (next < 0) {
    printf("You can't go that way.\n");
    return;
  }
  here = next;
  look();
}

int main(void) {
  char line[128];
  look();
  while (fgets(line, sizeof line, stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    if (strcmp(line, "look") == 0) look();
    else if (strcmp(line, "north") == 0) go(rooms[here].north);
    else if (strcmp(line, "south") == 0) go(rooms[here].south);
    else if (strcmp(line, "quit") == 0) break;
    else printf("I don't understand.\n");
  }
  return 0;
}
